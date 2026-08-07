import type { K8sObject } from '@shared/types'
import { parseCpuToMillicores, parseMemoryToBytes } from '@shared/quantity'
import { getByPath } from './getByPath'

type Metric = 'cpu' | 'memory'

function parse(metric: Metric, v: unknown): number {
  return metric === 'cpu' ? parseCpuToMillicores(v as string) : parseMemoryToBytes(v as string)
}

/** Sum of container limits (falling back to requests) for a pod, in millicores/bytes. */
export function podResourceRef(pod: K8sObject, metric: Metric): number {
  const containers = (getByPath(pod, 'spec.containers') as Array<{ resources?: { limits?: Record<string, string>; requests?: Record<string, string> } }>) ?? []
  let total = 0
  let found = false
  for (const c of containers) {
    const lim = c.resources?.limits?.[metric] ?? c.resources?.requests?.[metric]
    if (lim != null) {
      found = true
      total += parse(metric, lim)
    }
  }
  return found ? total : 0
}

/** Node allocatable for a metric, in millicores/bytes. */
export function nodeAllocatable(node: K8sObject, metric: Metric): number {
  const v = getByPath(node, `status.allocatable.${metric}`)
  return v != null ? parse(metric, v) : 0
}

/**
 * Reference used to scale a usage bar. Prefers a real denominator (pod
 * limit/request, or node allocatable) -> shows a true percentage; otherwise
 * falls back to a comparative max (no percentage label).
 */
export function usageReference(
  kind: string,
  obj: K8sObject,
  metric: Metric,
  fallbackMax: number
): { ref: number; isPercent: boolean } {
  if (kind === 'Node') {
    const a = nodeAllocatable(obj, metric)
    if (a > 0) return { ref: a, isPercent: true }
  } else {
    const l = podResourceRef(obj, metric)
    if (l > 0) return { ref: l, isPercent: true }
  }
  return { ref: fallbackMax, isPercent: false }
}
