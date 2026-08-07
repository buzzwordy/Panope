import type { AuditEntry } from '../shared/types'

/**
 * Shared-deployment action audit: who did what, when, and whether it worked.
 *
 * Two sinks:
 *  - an in-memory ring served to the UI (`auditLog` RPC) - team transparency;
 *  - one stdout line per action, so the cluster's log pipeline (Loki, ELK,
 *    CloudWatch...) captures a durable trail regardless of pod restarts.
 */

const MAX = Number(process.env.PANOPE_AUDIT_MEMORY || 1000)
const ring: AuditEntry[] = []

export function recordAudit(user: string, method: string, target: string, ok: boolean, error?: string): void {
  const entry: AuditEntry = { ts: Date.now(), user, method, target, ok, ...(error ? { error } : {}) }
  ring.push(entry)
  if (ring.length > MAX) ring.splice(0, ring.length - MAX)
  // Single greppable line; the log pipeline is the durable store.
  console.log(
    `[audit] ${new Date(entry.ts).toISOString()} user=${JSON.stringify(user || '(service account)')} ` +
      `action=${method} target=${JSON.stringify(target)} ok=${ok}${error ? ` error=${JSON.stringify(error)}` : ''}`
  )
}

/**
 * The audit ring, newest first.
 *
 * `forUser` scopes the result to one identity. The ring is process-wide and
 * shared by every session, and each entry names another user plus the object
 * they touched (namespace/name, file paths, replica counts) - handing all of it
 * to any authenticated caller would leak the shape of namespaces they cannot
 * otherwise see. Callers that legitimately need the whole trail (a privileged
 * role) pass no argument; the durable copy remains the pod's stdout, which is
 * read through the cluster's own log RBAC.
 */
export function auditEntries(forUser?: string): AuditEntry[] {
  const all = [...ring].reverse()
  return forUser === undefined ? all : all.filter((e) => e.user === forUser)
}

/** Human summary of a mutation's target from its raw RPC args. */
export function describeTarget(method: string, args: unknown[]): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  const nsName = (ns: unknown, name: unknown): string => (s(ns) ? `${s(ns)}/${s(name)}` : s(name))
  switch (method) {
    case 'applyYaml':
      return 'yaml manifest'
    case 'deleteResource':
    case 'restartResource':
      return `${s(args[0])} ${nsName(args[2], args[1])}`
    case 'patchMerge':
      return `${s(args[0])} ${nsName(args[2], args[1])}`
    case 'scaleResource':
      return `${s(args[0])} ${nsName(args[2], args[1])} -> ${String(args[3])}`
    case 'deleteCustom': {
      const ref = (args[0] ?? {}) as { plural?: string; group?: string }
      return `${ref.plural ?? '?'}.${ref.group ?? ''} ${nsName(args[2], args[1])}`
    }
    case 'drainNode':
      return s(args[0])
    case 'rollbackDeployment':
    case 'triggerCronJob':
    case 'rerunJob':
    case 'helmUninstall':
      return nsName(args[1], args[0])
    case 'helmRollback':
      return `${nsName(args[1], args[0])} -> rev ${String(args[2])}`
    case 'helmInstall':
    case 'helmUpgrade': {
      const spec = (args[0] ?? {}) as { release?: string; chart?: string; namespace?: string; version?: string }
      return `${spec.chart ?? '?'}${spec.version ? '@' + spec.version : ''} as ${spec.namespace ?? '?'}/${spec.release ?? '?'}`
    }
    case 'argoSync':
    case 'argoRefresh':
    case 'debugPod':
      return nsName(args[0], args[1])
    case 'nodeShell':
      return s(args[0])
    case 'podWriteFile':
      return `${nsName(args[0], args[1])}:${s(args[3])}`
    default:
      return method
  }
}
