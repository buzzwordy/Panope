import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import { notify } from './notifications'

type ToastKind = 'success' | 'error' | 'info'
interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  push: (kind: ToastKind, message: string) => void
  success: (m: string) => void
  error: (m: string) => void
  info: (m: string) => void
}

const Ctx = createContext<ToastApi>({ push: () => {}, success: () => {}, error: () => {}, info: () => {} })

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++seq.current
    // Keep it in the bell's history too, so it outlives the 3s toast.
    notify(kind, message)
    setToasts((t) => [...t, { id, kind, message }])
    const ttl = kind === 'error' ? 7000 : 3500
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl)
  }, [])

  const api: ToastApi = {
    push,
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m)
  }

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            <span className="toast__dot" />
            <span className="toast__msg">{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(Ctx)
}
