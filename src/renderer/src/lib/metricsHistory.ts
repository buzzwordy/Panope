import { api } from '../api'
import type { MetricSample } from '@shared/types'

/**
 * Rolling in-memory metrics history - the app samples metrics.k8s.io on a
 * fixed cadence and keeps the last ~30 minutes per pod/node plus cluster
 * totals, so tiles and detail views can show a trend, not just "80% right
 * now". No Prometheus required; the buffer costs a few hundred KB and is
 * dropped on context switch (another cluster's history would be a lie).
 */

export interface HistoryPoint {
  t: number
  /** millicores */
  cpu: number
  /** bytes */
  memory: number
}

export type MetricKind = 'pods' | 'nodes'

const INTERVAL_MS = 15000
const CAP = 120 // 120 x 15s = 30 minutes

const perKey: Record<MetricKind, Map<string, HistoryPoint[]>> = { pods: new Map(), nodes: new Map() }
const totals: Record<MetricKind, HistoryPoint[]> = { pods: [], nodes: [] }
const listeners = new Set<() => void>()

let timer: ReturnType<typeof setInterval> | undefined
let sampling = false

export function metricHistoryKey(namespace: string | undefined, name: string | undefined): string {
  return namespace ? `${namespace}/${name}` : `${name}`
}

function push(arr: HistoryPoint[], p: HistoryPoint): void {
  arr.push(p)
  if (arr.length > CAP) arr.splice(0, arr.length - CAP)
}

function ingest(kind: MetricKind, samples: MetricSample[], t: number): void {
  const map = perKey[kind]
  let cpu = 0
  let memory = 0
  const seen = new Set<string>()
  for (const s of samples) {
    const key = metricHistoryKey(s.namespace, s.name)
    seen.add(key)
    let arr = map.get(key)
    if (!arr) {
      arr = []
      map.set(key, arr)
    }
    push(arr, { t, cpu: s.cpu, memory: s.memory })
    cpu += s.cpu
    memory += s.memory
  }
  // Drop series for objects that no longer exist so the map can't grow forever.
  for (const key of map.keys()) if (!seen.has(key)) map.delete(key)
  push(totals[kind], { t, cpu, memory })
}

async function sample(): Promise<void> {
  if (sampling) return // a slow cluster must not stack requests
  sampling = true
  try {
    const t = Date.now()
    const [pods, nodes] = await Promise.all([api.getMetrics('pods'), api.getMetrics('nodes')])
    if (pods.available) ingest('pods', pods.samples, t)
    if (nodes.available) ingest('nodes', nodes.samples, t)
    if (pods.available || nodes.available) for (const cb of listeners) cb()
  } catch {
    /* metrics are best-effort */
  } finally {
    sampling = false
  }
}

/** Idempotent; the App mounts this once. */
export function startMetricsHistory(): void {
  if (timer) return
  void sample()
  timer = setInterval(() => void sample(), INTERVAL_MS)
}

/** Wipe everything (context switch - history from another cluster is a lie). */
export function resetMetricsHistory(): void {
  perKey.pods.clear()
  perKey.nodes.clear()
  totals.pods = []
  totals.nodes = []
  for (const cb of listeners) cb()
}

export function onMetricsHistory(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function historyFor(kind: MetricKind, namespace: string | undefined, name: string | undefined): HistoryPoint[] {
  return perKey[kind].get(metricHistoryKey(namespace, name)) ?? []
}

export function clusterHistory(kind: MetricKind): HistoryPoint[] {
  return totals[kind]
}
