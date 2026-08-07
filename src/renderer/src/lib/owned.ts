import type { K8sObject } from '@shared/types'
import { getByPath } from './getByPath'

/** The label selector a workload uses to own pods (matchLabels, or a plain map for RCs). */
export function getSelector(workload: K8sObject): Record<string, string> | null {
  const matchLabels = getByPath(workload, 'spec.selector.matchLabels') as Record<string, string> | undefined
  if (matchLabels && Object.keys(matchLabels).length) return matchLabels
  const plain = getByPath(workload, 'spec.selector') as Record<string, string> | undefined
  // ReplicationController's spec.selector is a plain map (no matchLabels).
  if (plain && typeof plain === 'object' && !('matchLabels' in plain) && Object.keys(plain).length) {
    return plain as Record<string, string>
  }
  return null
}

/** True if a pod's labels satisfy every entry of the selector. */
export function matchesSelector(pod: K8sObject, selector: Record<string, string>): boolean {
  const labels = pod.metadata?.labels ?? {}
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false
  }
  return true
}
