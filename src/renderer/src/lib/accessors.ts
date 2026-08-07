import type { K8sObject } from '@shared/types'
import { getByPath } from './getByPath'

export type StatusVariant = 'running' | 'pending' | 'failed' | 'succeeded' | 'unknown'
export interface StatusValue {
  label: string
  variant: StatusVariant
}

const RUNNING = /^(Running|Active|Ready|Bound|Available|Normal|True|Established)$/i
const PENDING =
  /^(Pending|ContainerCreating|PodInitializing|Progressing|Terminating|Released|Waiting|Init:|Warning)/i
const FAILED =
  /(Failed|Error|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|Evicted|OOMKilled|Lost|BackOff|Unschedulable|NotReady|InvalidImageName)/i
const SUCCEEDED = /^(Succeeded|Completed)$/i

export function statusVariant(text: string): StatusVariant {
  if (!text) return 'unknown'
  if (SUCCEEDED.test(text)) return 'succeeded'
  if (FAILED.test(text)) return 'failed'
  if (RUNNING.test(text)) return 'running'
  if (PENDING.test(text)) return 'pending'
  return 'unknown'
}

interface ContainerStatus {
  ready?: boolean
  restartCount?: number
  state?: {
    waiting?: { reason?: string }
    terminated?: { reason?: string; exitCode?: number; signal?: number }
    running?: unknown
  }
}

/** kubectl-like Pod status column. */
export function podStatus(pod: K8sObject): string {
  const meta = pod.metadata ?? {}
  const st = (pod.status ?? {}) as {
    phase?: string
    reason?: string
    initContainerStatuses?: ContainerStatus[]
    containerStatuses?: ContainerStatus[]
  }
  if (meta.deletionTimestamp) return 'Terminating'
  let reason = st.reason || st.phase || 'Unknown'

  const init = st.initContainerStatuses ?? []
  for (let i = 0; i < init.length; i++) {
    const c = init[i]
    const t = c.state?.terminated
    const w = c.state?.waiting
    if (t && t.exitCode === 0) continue
    if (t) {
      reason = t.reason ? `Init:${t.reason}` : `Init:ExitCode:${t.exitCode}`
    } else if (w && w.reason && w.reason !== 'PodInitializing') {
      reason = `Init:${w.reason}`
    } else {
      reason = `Init:${i}/${init.length}`
    }
    return reason
  }

  const cs = st.containerStatuses ?? []
  let running = false
  let hasReason = false
  for (const c of cs) {
    const w = c.state?.waiting
    const t = c.state?.terminated
    if (w?.reason) {
      reason = w.reason
      hasReason = true
    } else if (t?.reason) {
      reason = t.reason
      hasReason = true
    } else if (t && t.reason === undefined) {
      reason = t.signal ? `Signal:${t.signal}` : `ExitCode:${t.exitCode}`
      hasReason = true
    } else if (c.state?.running && c.ready) {
      running = true
    }
  }
  if (!hasReason && reason === 'Completed' && running) reason = 'Running'
  return reason
}

function readyPair(ready: number, total: number): string {
  return `${ready}/${total}`
}

function abbrevAccessMode(m: string): string {
  switch (m) {
    case 'ReadWriteOnce':
      return 'RWO'
    case 'ReadOnlyMany':
      return 'ROX'
    case 'ReadWriteMany':
      return 'RWX'
    case 'ReadWriteOncePod':
      return 'RWOP'
    default:
      return m
  }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** Computed accessors keyed by ColumnDef.id. Return string | number | StatusValue. */
export const COMPUTE: Record<string, (o: K8sObject) => string | number | StatusValue> = {
  // Namespaces
  'ns.status': (o) => {
    const p = (getByPath(o, 'status.phase') as string) ?? 'Active'
    return { label: p, variant: p === 'Active' ? 'running' : p === 'Terminating' ? 'pending' : 'unknown' }
  },

  // Nodes
  'node.status': (o) => {
    const conds = (getByPath(o, 'status.conditions') as Array<{ type?: string; status?: string }>) ?? []
    const ready = conds.find((c) => c.type === 'Ready')
    let label = ready?.status === 'True' ? 'Ready' : 'NotReady'
    if (getByPath(o, 'spec.unschedulable')) label += ',SchedulingDisabled'
    return { label, variant: ready?.status === 'True' ? 'running' : 'failed' }
  },
  'node.roles': (o) => {
    const labels = (o.metadata?.labels ?? {}) as Record<string, string>
    const roles = Object.keys(labels)
      .filter((k) => k.startsWith('node-role.kubernetes.io/'))
      .map((k) => k.replace('node-role.kubernetes.io/', ''))
      .filter(Boolean)
    return roles.length ? roles.join(',') : '<none>'
  },
  'node.ip': (o) => {
    const addrs = (getByPath(o, 'status.addresses') as Array<{ type?: string; address?: string }>) ?? []
    return addrs.find((a) => a.type === 'InternalIP')?.address ?? ''
  },

  // Pods
  'pod.status': (o) => {
    const label = podStatus(o)
    return { label, variant: statusVariant(label) }
  },
  'pod.ready': (o) => {
    const cs = (getByPath(o, 'status.containerStatuses') as ContainerStatus[]) ?? []
    const ready = cs.filter((c) => c.ready).length
    return readyPair(ready, cs.length)
  },
  'pod.restarts': (o) => {
    const cs = (getByPath(o, 'status.containerStatuses') as ContainerStatus[]) ?? []
    return cs.reduce((a, c) => a + num(c.restartCount), 0)
  },

  // Deployments / StatefulSets
  'deploy.ready': (o) =>
    readyPair(num(getByPath(o, 'status.readyReplicas')), num(getByPath(o, 'status.replicas')) || num(getByPath(o, 'spec.replicas'))),
  'sts.ready': (o) =>
    readyPair(num(getByPath(o, 'status.readyReplicas')), num(getByPath(o, 'status.replicas')) || num(getByPath(o, 'spec.replicas'))),

  // Jobs
  'job.status': (o) => {
    const conds = (getByPath(o, 'status.conditions') as Array<{ type?: string; status?: string }>) ?? []
    if (conds.some((c) => c.type === 'Complete' && c.status === 'True'))
      return { label: 'Complete', variant: 'succeeded' }
    if (conds.some((c) => c.type === 'Failed' && c.status === 'True'))
      return { label: 'Failed', variant: 'failed' }
    return { label: 'Running', variant: 'running' }
  },
  'job.completions': (o) =>
    readyPair(num(getByPath(o, 'status.succeeded')), num(getByPath(o, 'spec.completions')) || 1),
  'job.duration': (o) => {
    const start = getByPath(o, 'status.startTime') as string | undefined
    if (!start) return '-'
    const end = getByPath(o, 'status.completionTime') as string | undefined
    const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start)
    if (ms < 0) return '-'
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  },

  // CronJobs
  'cron.active': (o) => ((getByPath(o, 'status.active') as unknown[]) ?? []).length,

  // Events
  'event.type': (o) => {
    const t = (getByPath(o, 'type') as string) ?? ''
    return { label: t || 'Normal', variant: t === 'Warning' ? 'pending' : 'unknown' }
  },
  'event.object': (o) => {
    const k = getByPath(o, 'involvedObject.kind') as string
    const n = getByPath(o, 'involvedObject.name') as string
    return k && n ? `${k}/${n}` : n || ''
  },

  // ConfigMaps / Secrets / ServiceAccounts
  'cm.keys': (o) =>
    Object.keys((o.data as object) ?? {}).length + Object.keys((o.binaryData as object) ?? {}).length,
  'secret.keys': (o) => Object.keys((o.data as object) ?? {}).length,
  'sa.secrets': (o) => ((o.secrets as unknown[]) ?? []).length,

  // HPA
  'hpa.reference': (o) => {
    const k = getByPath(o, 'spec.scaleTargetRef.kind') as string
    const n = getByPath(o, 'spec.scaleTargetRef.name') as string
    return k && n ? `${k}/${n}` : n || ''
  },

  // Services / Ingress / Endpoints
  'svc.external': (o) => {
    const lb = (getByPath(o, 'status.loadBalancer.ingress') as Array<{ ip?: string; hostname?: string }>) ?? []
    const lbIps = lb.map((i) => i.ip || i.hostname).filter(Boolean)
    if (lbIps.length) return lbIps.join(', ')
    const ext = (getByPath(o, 'spec.externalIPs') as string[]) ?? []
    if (ext.length) return ext.join(', ')
    return (getByPath(o, 'spec.type') as string) === 'LoadBalancer' ? '<pending>' : '<none>'
  },
  'svc.ports': (o) => {
    const ports = (getByPath(o, 'spec.ports') as Array<{ port?: number; nodePort?: number; protocol?: string }>) ?? []
    return ports
      .map((p) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol ?? 'TCP'}`)
      .join(', ')
  },
  'ing.hosts': (o) => {
    const rules = (getByPath(o, 'spec.rules') as Array<{ host?: string }>) ?? []
    const hosts = rules.map((r) => r.host).filter(Boolean)
    return hosts.length ? hosts.join(', ') : '*'
  },
  'ing.address': (o) => {
    const lb = (getByPath(o, 'status.loadBalancer.ingress') as Array<{ ip?: string; hostname?: string }>) ?? []
    const addrs = lb.map((i) => i.ip || i.hostname).filter(Boolean)
    return addrs.length ? addrs.join(', ') : '<pending>'
  },
  'ep.addresses': (o) => {
    const subsets = (getByPath(o, 'subsets') as Array<{ addresses?: Array<{ ip?: string }>; ports?: Array<{ port?: number }> }>) ?? []
    const ips = subsets.flatMap((s) => (s.addresses ?? []).map((a) => a.ip)).filter(Boolean)
    const ports = subsets.flatMap((s) => (s.ports ?? []).map((p) => p.port)).filter(Boolean)
    if (!ips.length) return '<none>'
    const head = ips.slice(0, 2).map((ip) => (ports[0] ? `${ip}:${ports[0]}` : `${ip}`))
    return head.join(', ') + (ips.length > 2 ? ` +${ips.length - 2}` : '')
  },

  // PV / PVC
  'pv.access': (o) =>
    (((getByPath(o, 'spec.accessModes') as string[]) ?? []).map(abbrevAccessMode)).join(',') || '',
  'pv.status': (o) => {
    const phase = (getByPath(o, 'status.phase') as string) ?? 'Unknown'
    return { label: phase, variant: statusVariant(phase) }
  },
  'pv.claim': (o) => {
    const ns = getByPath(o, 'spec.claimRef.namespace') as string
    const n = getByPath(o, 'spec.claimRef.name') as string
    return n ? (ns ? `${ns}/${n}` : n) : ''
  },
  'pvc.status': (o) => {
    const phase = (getByPath(o, 'status.phase') as string) ?? 'Unknown'
    return { label: phase, variant: statusVariant(phase) }
  },

  // RBAC bindings
  'rb.role': (o) => (getByPath(o, 'roleRef.name') as string) ?? '',
  'crb.role': (o) => (getByPath(o, 'roleRef.name') as string) ?? '',

  // Helm releases
  'rel.status': (o) => {
    // status is a string on helm release pseudo-objects; guard against being
    // rendered mid-switch with a real k8s object (whose status is an object).
    const raw = getByPath(o, 'status')
    const s = typeof raw === 'string' ? raw : 'unknown'
    let variant: StatusVariant = 'unknown'
    if (s === 'deployed') variant = 'running'
    else if (s === 'failed') variant = 'failed'
    else if (s.startsWith('pending') || s === 'uninstalling') variant = 'pending'
    else if (s === 'superseded') variant = 'succeeded'
    return { label: s, variant }
  },

  // ArgoCD Applications
  'argo.sync': (o) => {
    const s = (getByPath(o, 'status.sync.status') as string) ?? 'Unknown'
    const variant: StatusVariant = s === 'Synced' ? 'running' : s === 'OutOfSync' ? 'pending' : 'unknown'
    return { label: s, variant }
  },
  'argo.health': (o) => {
    const h = (getByPath(o, 'status.health.status') as string) ?? 'Unknown'
    let variant: StatusVariant = 'unknown'
    if (h === 'Healthy') variant = 'running'
    else if (h === 'Progressing') variant = 'pending'
    else if (h === 'Degraded' || h === 'Missing') variant = 'failed'
    else if (h === 'Suspended') variant = 'unknown'
    return { label: h, variant }
  }
}
