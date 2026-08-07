import type { KubernetesService, ExecHandle, PfHandle, StreamHandle, WatchSession } from '../main/kube/client'
import type { Policy } from './authz'

/**
 * Per-connection state. In the desktop app the main process is single-user, so
 * streams live in module-level maps. On a shared server every socket gets its
 * own registry and its own impersonated view of the cluster, so one user can
 * never see or stop another user's streams.
 */
export interface Identity {
  user: string
  groups: string[]
  email?: string
}

/** Caps per connection - an unbounded client could otherwise pin the apiserver. */
const MAX_WATCHES = Number(process.env.PANOPE_MAX_WATCHES || 40)
const MAX_LOGS = Number(process.env.PANOPE_MAX_LOG_STREAMS || 30)
const MAX_EXECS = Number(process.env.PANOPE_MAX_EXEC_SESSIONS || 5)

export class Session {
  readonly watches = new Map<string, WatchSession>()
  readonly logs = new Map<string, StreamHandle>()
  readonly execs = new Map<string, ExecHandle>()
  readonly pfs = new Map<string, PfHandle>()

  /** Cluster access already scoped to this user's identity. */
  readonly svc: KubernetesService

  private counter = 0

  constructor(
    base: KubernetesService,
    readonly identity: Identity,
    readonly id: string,
    readonly policy: Policy
  ) {
    // An empty user means "no impersonation" - act as the ServiceAccount (or
    // the mounted kubeconfig when running locally). Impersonating a name with
    // no RBAC would 403 every call.
    this.svc = identity.user ? base.withIdentity(identity.user, identity.groups) : base
  }

  nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}${this.counter}`
  }

  /** Throws when this connection is already at its cap for `kind`. */
  assertCapacity(kind: 'watch' | 'log' | 'exec'): void {
    const [size, max, label] =
      kind === 'watch'
        ? [this.watches.size, MAX_WATCHES, 'watches']
        : kind === 'log'
          ? [this.logs.size, MAX_LOGS, 'log streams']
          : [this.execs.size, MAX_EXECS, 'exec sessions']
    if (size >= max) throw new Error(`too many concurrent ${label} for this session (limit ${max})`)
  }

  /** Tear down everything this connection owns. */
  dispose(): void {
    for (const map of [this.watches, this.logs, this.execs, this.pfs]) {
      for (const [, handle] of map) {
        try {
          handle.stop()
        } catch {
          /* ignore */
        }
      }
      map.clear()
    }
  }
}
