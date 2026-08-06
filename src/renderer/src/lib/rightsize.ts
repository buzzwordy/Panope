import type { K8sObject, MetricSample } from '@shared/types'
import { parseCpuToMillicores, parseMemoryToBytes } from '@shared/quantity'
import { getByPath } from './getByPath'

/**
 * Right-sizing analysis: measured usage vs declared requests, per container.
 *
 * Usage from metrics.k8s.io arrives per POD, so container rows within a pod
 * share the pod total proportionally to their requests (or evenly when no
 * container declares any) - good enough to spot the 10x-overprovisioned and
 * the about-to-be-throttled, which is what this view is for.
 */

export interface SizingRow {
  namespace: string
  pod: string
  container: string
  /** controller that owns the pod, e.g. "Deployment/api" */
  owner?: string
  cpuUsage: number | null
  cpuRequest: number
  cpuLimit: number
  memUsage: number | null
  memRequest: number
  memLimit: number
  /** usage/request in percent; null when request is 0 or no usage sample */
  cpuPct: number | null
  memPct: number | null
  restarts: number
  oomKilled: boolean
  issues: SizingIssue[]
}

export type SizingIssue =
  | 'no-requests'
  | 'no-limits'
  | 'cpu-overprovisioned'
  | 'mem-overprovisioned'
  | 'cpu-underprovisioned'
  | 'mem-underprovisioned'
  | 'oom-killed'

export const OVER_AT = 10 // <10% of request used -> overprovisioned
export const UNDER_AT = 90 // >90% of request used -> underprovisioned

interface ContainerSpec {
  name: string
  resources?: {
    requests?: Record<string, string>
    limits?: Record<string, string>
  }
}

function ownerOf(pod: K8sObject): string | undefined {
  const ref = pod.metadata?.ownerReferences?.[0]
  return ref ? `${ref.kind}/${ref.name}` : undefined
}

export function analyzePods(pods: K8sObject[], metrics: Map<string, MetricSample>): SizingRow[] {
  const rows: SizingRow[] = []
  for (const pod of pods) {
    const ns = pod.metadata?.namespace ?? ''
    const podName = pod.metadata?.name ?? ''
    if ((getByPath(pod, 'status.phase') as string) !== 'Running') continue

    const containers = (getByPath(pod, 'spec.containers') as ContainerSpec[] | undefined) ?? []
    const statuses =
      (getByPath(pod, 'status.containerStatuses') as
        | Array<{
            name: string
            restartCount?: number
            lastState?: { terminated?: { reason?: string } }
            state?: { terminated?: { reason?: string } }
          }>
        | undefined) ?? []

    const sample = metrics.get(ns ? `${ns}/${podName}` : podName)
    const totalCpuReq = containers.reduce((a, c) => a + parseCpuToMillicores(c.resources?.requests?.cpu), 0)
    const totalMemReq = containers.reduce((a, c) => a + parseMemoryToBytes(c.resources?.requests?.memory), 0)

    for (const c of containers) {
      const cpuRequest = parseCpuToMillicores(c.resources?.requests?.cpu)
      const cpuLimit = parseCpuToMillicores(c.resources?.limits?.cpu)
      const memRequest = parseMemoryToBytes(c.resources?.requests?.memory)
      const memLimit = parseMemoryToBytes(c.resources?.limits?.memory)

      // Split the pod-level usage across containers by request share.
      let cpuUsage: number | null = null
      let memUsage: number | null = null
      if (sample) {
        const cpuShare = totalCpuReq > 0 ? cpuRequest / totalCpuReq : 1 / containers.length
        const memShare = totalMemReq > 0 ? memRequest / totalMemReq : 1 / containers.length
        cpuUsage = sample.cpu * cpuShare
        memUsage = sample.memory * memShare
      }

      const st = statuses.find((s) => s.name === c.name)
      const restarts = st?.restartCount ?? 0
      const oomKilled =
        st?.lastState?.terminated?.reason === 'OOMKilled' || st?.state?.terminated?.reason === 'OOMKilled'

      const cpuPct = cpuUsage !== null && cpuRequest > 0 ? (cpuUsage / cpuRequest) * 100 : null
      const memPct = memUsage !== null && memRequest > 0 ? (memUsage / memRequest) * 100 : null

      const issues: SizingIssue[] = []
      if (oomKilled) issues.push('oom-killed')
      if (!cpuRequest && !memRequest) issues.push('no-requests')
      if (!cpuLimit && !memLimit) issues.push('no-limits')
      if (cpuPct !== null && cpuPct < OVER_AT) issues.push('cpu-overprovisioned')
      if (memPct !== null && memPct < OVER_AT) issues.push('mem-overprovisioned')
      if (cpuPct !== null && cpuPct > UNDER_AT) issues.push('cpu-underprovisioned')
      if (memPct !== null && memPct > UNDER_AT) issues.push('mem-underprovisioned')

      rows.push({
        namespace: ns,
        pod: podName,
        container: c.name,
        owner: ownerOf(pod),
        cpuUsage,
        cpuRequest,
        cpuLimit,
        memUsage,
        memRequest,
        memLimit,
        cpuPct,
        memPct,
        restarts,
        oomKilled,
        issues
      })
    }
  }
  return rows
}

/** Sort: real problems first (OOM, underprovisioned), then waste, then rest. */
export function severityRank(row: SizingRow): number {
  if (row.issues.includes('oom-killed')) return 0
  if (row.issues.includes('mem-underprovisioned') || row.issues.includes('cpu-underprovisioned')) return 1
  if (row.issues.includes('no-requests')) return 2
  if (row.issues.includes('mem-overprovisioned') || row.issues.includes('cpu-overprovisioned')) return 3
  if (row.issues.includes('no-limits')) return 4
  return 5
}
