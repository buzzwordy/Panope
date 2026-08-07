import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ResourceDef } from '@shared/catalog'
import type { K8sObject, MetricSample } from '@shared/types'

export interface MetricsMap {
  available: boolean
  byKey: Map<string, MetricSample>
}

export interface ResourceData {
  items: K8sObject[]
  loading: boolean
  error?: string
  metrics: MetricsMap
  refresh: () => void
}

function objKey(o: K8sObject): string {
  return o.metadata?.uid || `${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`
}

export function metricKey(namespace: string | undefined, name: string | undefined): string {
  return namespace ? `${namespace}/${name}` : `${name}`
}

const METRIC_POLL_MS = 8000

export function useResourceData(def: ResourceDef | undefined, contextVersion: number): ResourceData {
  const [items, setItems] = useState<K8sObject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [metrics, setMetrics] = useState<MetricsMap>({ available: false, byKey: new Map() })
  const [nonce, setNonce] = useState(0)

  const mapRef = useRef<Map<string, K8sObject>>(new Map())
  // Which resource the current `items` belong to. Effects run after render, so
  // without this a resource switch renders the NEW def against the OLD items
  // for one frame - computed columns then run on the wrong object shape.
  const itemsKeyRef = useRef<string | undefined>(undefined)
  const key = def?.key

  useEffect(() => {
    if (!def) return
    let disposed = false
    let subId = ''
    let unsub: (() => void) | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined

    const commit = (): void => {
      if (!disposed) setItems(Array.from(mapRef.current.values()))
    }

    setLoading(true)
    setError(undefined)
    mapRef.current = new Map()
    itemsKeyRef.current = def.key
    setItems([])

    // 1) initial list (custom vs built-in)
    const listPromise = def.custom ? api.listCustom(def.custom) : api.listResource(def.key)
    listPromise
      .then((res) => {
        if (disposed) return
        const m = new Map<string, K8sObject>()
        for (const o of res.items) m.set(objKey(o), o)
        mapRef.current = m
        setError(res.error)
        commit()
      })
      .catch((e) => !disposed && setError(String(e)))
      .finally(() => !disposed && setLoading(false))

    // 2) metrics (pods / nodes only)
    const metricKind: 'pods' | 'nodes' | null =
      def.key === 'pods' ? 'pods' : def.key === 'nodes' ? 'nodes' : null
    const loadMetrics = (): void => {
      if (!metricKind) return
      api.getMetrics(metricKind).then((res) => {
        if (disposed) return
        const byKey = new Map<string, MetricSample>()
        for (const s of res.samples) byKey.set(metricKey(s.namespace, s.name), s)
        setMetrics({ available: res.available, byKey })
      })
    }
    if (metricKind) {
      loadMetrics()
      pollTimer = setInterval(loadMetrics, METRIC_POLL_MS)
    } else {
      setMetrics({ available: false, byKey: new Map() })
    }

    // 3) live watch
    unsub = api.onWatchEvent((ev) => {
      if (disposed || ev.subscriptionId !== subId || !ev.object) return
      const k = objKey(ev.object)
      if (ev.type === 'DELETED') mapRef.current.delete(k)
      else if (ev.type === 'ADDED' || ev.type === 'MODIFIED') mapRef.current.set(k, ev.object)
      else return
      commit()
    })
    const watchPromise = def.custom ? api.startWatchCustom(def.custom) : api.startWatch(def.key)
    watchPromise.then((id) => {
      if (disposed) {
        if (id) api.stopWatch(id)
        return
      }
      subId = id
    })

    return () => {
      disposed = true
      unsub?.()
      if (subId) api.stopWatch(subId)
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [key, contextVersion, nonce])

  // Never hand out items that belong to a different resource than `def`.
  const safeItems = itemsKeyRef.current === key ? items : []
  return { items: safeItems, loading, error, metrics, refresh: () => setNonce((n) => n + 1) }
}
