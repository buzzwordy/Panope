import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { PortForwardInfo } from '@shared/types'

/** One automatic reconnect per forward: pods restart, services re-resolve. */
const RETRY_DELAY_MS = 2500

interface PFState {
  forwards: PortForwardInfo[]
  start: (namespace: string, pod: string, remotePort: number, localPort?: number) => Promise<PortForwardInfo>
  startService: (namespace: string, service: string, servicePort: number, localPort?: number) => Promise<PortForwardInfo>
  stop: (id: string) => Promise<void>
  refresh: () => void
}

const Ctx = createContext<PFState>({
  forwards: [],
  start: async () => ({ id: '', namespace: '', pod: '', remotePort: 0, localPort: 0 }),
  startService: async () => ({ id: '', namespace: '', pod: '', remotePort: 0, localPort: 0 }),
  stop: async () => {},
  refresh: () => {}
})

export function PortForwardProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [forwards, setForwards] = useState<PortForwardInfo[]>([])

  const refresh = useCallback(() => {
    void api.pfList().then(setForwards)
  }, [])

  // ids we already retried, so a dead target doesn't reconnect-loop
  const retriedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    refresh()
    const unsub = api.onPfEvent((info) => {
      refresh()
      // Auto-reconnect once when a forward dies unexpectedly (pod restarted).
      const userIntended = /read-only|context switched/i.test(info.error ?? '')
      if (info.error && !userIntended && !retriedRef.current.has(info.id)) {
        retriedRef.current.add(info.id)
        setTimeout(async () => {
          try {
            const next = info.service
              ? await api.pfStartService(info.namespace, info.service, info.remotePort, info.localPort)
              : await api.pfStart(info.namespace, info.pod, info.remotePort, info.localPort)
            // let the replacement retry once too if it later dies
            if (!next.error) retriedRef.current.delete(info.id)
          } finally {
            refresh()
          }
        }, RETRY_DELAY_MS)
      }
    })
    return unsub
  }, [refresh])

  const start = useCallback(
    async (namespace: string, pod: string, remotePort: number, localPort?: number) => {
      const info = await api.pfStart(namespace, pod, remotePort, localPort)
      refresh()
      return info
    },
    [refresh]
  )

  const startService = useCallback(
    async (namespace: string, service: string, servicePort: number, localPort?: number) => {
      const info = await api.pfStartService(namespace, service, servicePort, localPort)
      refresh()
      return info
    },
    [refresh]
  )

  const stop = useCallback(
    async (id: string) => {
      await api.pfStop(id)
      refresh()
    },
    [refresh]
  )

  return <Ctx.Provider value={{ forwards, start, startService, stop, refresh }}>{children}</Ctx.Provider>
}

export function usePortForwards(): PFState {
  return useContext(Ctx)
}
