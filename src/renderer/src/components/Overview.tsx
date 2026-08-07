import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ClusterInfo, K8sObject } from '@shared/types'
import { getResourceDef, type ResourceDef } from '@shared/catalog'
import { parseCpuToMillicores, parseMemoryToBytes } from '@shared/quantity'
import { api } from '../api'
import type { Catalog } from '../hooks/useCatalog'
import { podStatus, statusVariant } from '../lib/accessors'
import { getByPath } from '../lib/getByPath'
import { formatCpu, formatMemory, humanDuration } from '../lib/format'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { clusterHistory, onMetricsHistory } from '../lib/metricsHistory'
import { Icon } from './Icon'
import { Spark } from './cells/Spark'

interface Props {
  counts: Record<string, number | undefined>
  clusterInfo?: ClusterInfo
  contextVersion: number
  now: number
  catalog: Catalog
  onSelect: (key: string) => void
  onOpen: (def: ResourceDef, obj: K8sObject, tab?: string) => void
}

const TILES: Array<[string, string]> = [
  ['nodes', 'Nodes'],
  ['services', 'Services'],
  ['pods', 'Pods'],
  ['secrets', 'Secrets'],
  ['deployments', 'Deployments'],
  ['statefulsets', 'StatefulSets'],
  ['daemonsets', 'DaemonSets'],
  ['jobs', 'Jobs'],
  ['cronjobs', 'CronJobs'],
  ['configmaps', 'Config'],
  ['ingresses', 'Ingresses'],
  ['persistentvolumeclaims', 'Claims']
]

const REFRESH_MS = 30000
const TOP_N = 5
/** Default panel arrangement; also the source of truth for "what panels exist",
 *  so a saved layout from an older version still gains new panels. */
const DEFAULT_PANEL_ORDER = [
  'problems',
  'warnings',
  'degraded',
  'pending',
  'topcpu',
  'topmem',
  'restarts',
  'nodes',
  'storage',
  'namespaces',
  'gitopsfleet',
  'gitops',
  'syncfail',
  'recentsync',
  'crossplane',
  'helm'
]
/** how long a panel pulses after new items appear */
const FLASH_MS = 8000

// Utilisation thresholds shared by every gauge, bar and readout so a colour
// always means the same thing.
type Level = 'ok' | 'warn' | 'crit'
const WARN_AT = 75
const CRIT_AT = 90
function levelOf(pct: number | null | undefined): Level {
  if (pct === null || pct === undefined) return 'ok'
  if (pct >= CRIT_AT) return 'crit'
  if (pct >= WARN_AT) return 'warn'
  return 'ok'
}

/** Events use lastTimestamp, but newer (events.k8s.io) events only set
 *  eventTime; fall back through both, then creationTimestamp. */
const eventTs = (e: K8sObject): string =>
  (getByPath(e, 'lastTimestamp') as string) ||
  (getByPath(e, 'eventTime') as string) ||
  (e.metadata?.creationTimestamp as string) ||
  ''

const PROBLEM_STATES = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|Error|Evicted|OOMKilled|Unknown|InvalidImageName|CreateContainerConfigError/
const PENDING_STATES = /Pending|ContainerCreating|PodInitializing/

interface ContainerStateEntry {
  restartCount?: number
  state?: { terminated?: { finishedAt?: string }; running?: { startedAt?: string } }
  lastState?: { terminated?: { finishedAt?: string } }
}

/** When a pod entered its current trouble: the most recent container state
 *  transition if the kubelet reported one, else the pod's own start time. */
function problemSince(pod: K8sObject): string {
  const statuses = [
    ...((getByPath(pod, 'status.containerStatuses') as ContainerStateEntry[]) ?? []),
    ...((getByPath(pod, 'status.initContainerStatuses') as ContainerStateEntry[]) ?? [])
  ]
  let newest = ''
  for (const c of statuses) {
    const t =
      c.state?.terminated?.finishedAt || c.state?.running?.startedAt || c.lastState?.terminated?.finishedAt || ''
    if (t && (!newest || Date.parse(t) > Date.parse(newest))) newest = t
  }
  return newest || (getByPath(pod, 'status.startTime') as string) || (pod.metadata?.creationTimestamp as string) || ''
}

const absolute = (ts: string): string | undefined => (ts ? new Date(ts).toLocaleString() : undefined)

function restartsOf(pod: K8sObject): number {
  const cs = (getByPath(pod, 'status.containerStatuses') as ContainerStateEntry[]) ?? []
  return cs.reduce((n, c) => n + (c.restartCount ?? 0), 0)
}

/** Sum of container resource *requests* - what the scheduler reserves. */
function podRequests(pod: K8sObject): { cpu: number; memory: number } {
  const containers =
    (getByPath(pod, 'spec.containers') as Array<{ resources?: { requests?: Record<string, string> } }>) ?? []
  let cpu = 0
  let memory = 0
  for (const c of containers) {
    cpu += parseCpuToMillicores(c.resources?.requests?.cpu)
    memory += parseMemoryToBytes(c.resources?.requests?.memory)
  }
  return { cpu, memory }
}

const podKey = (o: K8sObject): string => `${o.metadata?.namespace}/${o.metadata?.name}`

interface Snapshot {
  cpuUsed: number
  cpuTotal: number
  memUsed: number
  memTotal: number
  cpuReq: number
  memReq: number
  /** running pods vs the sum of every node's allocatable pod slots */
  podCount: number
  podCapacity: number
  nodes: K8sObject[]
  nodesReady: number
  nodeUsage: Map<string, { cpu: number; memory: number }>
  podsPerNode: Map<string, number>
  problems: K8sObject[]
  pending: K8sObject[]
  restarters: K8sObject[]
  topCpu: Array<{ pod: K8sObject; value: number }>
  topMem: Array<{ pod: K8sObject; value: number }>
  degraded: Array<{ def: string; obj: K8sObject; ready: number; desired: number }>
  namespaces: Array<{ name: string; pods: number; cpu: number }>
  warnings: K8sObject[]
  pvcPending: number
  pvcBound: number
  pvUnbound: number
  storageTotal: number
  versions: string[]
  argoBad: K8sObject[]
  /** counts by sync + health across every Application */
  argoRollup: { synced: number; outOfSync: number; healthy: number; progressing: number; degraded: number; missing: number; total: number }
  /** Applications whose last sync operation errored - distinct from drift */
  argoFailedOps: K8sObject[]
  /** most recently finished syncs, newest first */
  argoRecent: K8sObject[]
  /** Crossplane providers with install/health state */
  xpProviders: K8sObject[]
  helmBad: K8sObject[]
  metricsOk: boolean
}

/** Value of a standard Kubernetes condition on any object. */
function conditionOf(obj: K8sObject, type: string): string | undefined {
  const conds = (getByPath(obj, 'status.conditions') as Array<{ type?: string; status?: string }>) ?? []
  return conds.find((c) => c.type === type)?.status
}

const argoOpPhase = (a: K8sObject): string => (getByPath(a, 'status.operationState.phase') as string) ?? ''
const argoOpFinished = (a: K8sObject): string => (getByPath(a, 'status.operationState.finishedAt') as string) ?? ''

/** Small horizontal bar used across the dashboard panels. */
function Bar({ pct, level }: { pct: number; level?: Level }): React.ReactElement {
  const lv = level ?? levelOf(pct)
  return (
    <span className="ov-minibar">
      <span className={`ov-minibar__fill is-${lv}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  )
}

function Gauge({
  label,
  value,
  pct,
  level,
  trend
}: {
  label: string
  value: string
  pct: number | null
  /** override when "high" isn't the bad direction (e.g. nodes ready) */
  level?: Level
  /** optional usage history behind the bar (30 min sparkline) */
  trend?: number[]
}): React.ReactElement {
  const lv = level ?? levelOf(pct)
  return (
    <div className={`ov-gauge is-${lv}`}>
      <div className="ov-gauge__head">
        <span>{label}</span>
        <span className={`ov-gauge__val is-${lv}`}>{value}</span>
      </div>
      {trend && trend.length >= 2 && (
        <div className="ov-gauge__trend" title="Last 30 minutes">
          <Spark
            values={trend}
            width={210}
            height={22}
            color={lv === 'crit' ? 'var(--color-danger)' : lv === 'warn' ? 'var(--color-warning)' : 'var(--color-brand)'}
          />
        </div>
      )}
      <div className="ov-gauge__bar">
        <div className={`ov-gauge__fill is-${lv}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
    </div>
  )
}

/** Dashboard arrangement, provided by Overview and consumed by every Panel so
 *  panels can be reordered/hidden without restructuring the JSX tree. Ordering
 *  rides on CSS grid `order`, so the DOM stays stable while dragging. */
interface LayoutState {
  editing: boolean
  order: string[]
  hidden: string[]
  onDropOn: (targetId: string) => void
  onDragStart: (id: string) => void
  toggleHidden: (id: string) => void
}
const LayoutCtx = React.createContext<LayoutState | null>(null)

function Panel({
  id,
  title,
  icon,
  count,
  severity,
  wide,
  flashing,
  onSilence,
  children
}: {
  /** stable identity used for ordering + hiding */
  id: string
  title: string
  icon: string
  count?: number | null
  severity?: 'error' | 'warn'
  /** span two grid columns - for rows carrying extra metrics */
  wide?: boolean
  /** pulse the panel because new items just appeared */
  flashing?: boolean
  onSilence?: () => void
  children: React.ReactNode
}): React.ReactElement | null {
  const layout = React.useContext(LayoutCtx)
  const isHidden = !!layout?.hidden.includes(id)
  const editing = !!layout?.editing
  if (isHidden && !editing) return null
  const idx = layout?.order.indexOf(id) ?? -1
  return (
    <section
      style={idx >= 0 ? { order: idx } : undefined}
      draggable={editing}
      onDragStart={editing ? () => layout?.onDragStart(id) : undefined}
      onDragOver={editing ? (e) => e.preventDefault() : undefined}
      onDrop={
        editing
          ? (e) => {
              e.preventDefault()
              layout?.onDropOn(id)
            }
          : undefined
      }
      className={[
        'ov-panel',
        severity ? `ov-panel--${severity}` : '',
        wide ? 'ov-panel--wide' : '',
        flashing && !editing ? `is-flashing is-flashing--${severity ?? 'warn'}` : '',
        editing ? 'is-editing' : '',
        isHidden ? 'is-hidden-panel' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {editing && (
        <button
          className="ov-panel__toggle"
          title={isHidden ? 'Show this panel' : 'Hide this panel'}
          onClick={() => layout?.toggleHidden(id)}
        >
          <Icon name={isHidden ? 'plus' : 'close'} size={12} />
        </button>
      )}
      <header className="ov-panel__head">
        <Icon name={icon} size={14} />
        <h2>{title}</h2>
        {flashing && (
          <button className="ov-silence" onClick={onSilence} title="Silence this alert">
            <Icon name="close" size={12} /> silence
          </button>
        )}
        {count !== undefined && (
          <span className={`ov-badge${count ? (severity === 'warn' ? ' is-warn' : severity ? ' is-bad' : '') : ''}`}>
            {count === null ? '...' : count}
          </span>
        )}
      </header>
      {children}
    </section>
  )
}

export function Overview({
  counts,
  clusterInfo,
  contextVersion,
  now,
  catalog,
  onSelect,
  onOpen
}: Props): React.ReactElement {
  const [snap, setSnap] = useState<Snapshot | null>(null)

  // cluster usage trend (nodes totals) for the CPU/Memory gauges
  const [histTick, setHistTick] = useState(0)
  useEffect(() => onMetricsHistory(() => setHistTick((t) => t + 1)), [])
  const cpuTrend = useMemo(() => clusterHistory('nodes').map((p) => p.cpu), [histTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const memTrend = useMemo(() => clusterHistory('nodes').map((p) => p.memory), [histTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // The ArgoCD Application def, when the CRD exists on this cluster.
  const argoDef = useMemo(
    () => [...catalog.byKey.values()].find((d) => (d.custom?.group ?? d.group) === 'argoproj.io' && d.kind === 'Application'),
    [catalog]
  )
  // Crossplane Provider def - an unhealthy provider breaks everything it manages.
  const xpDef = useMemo(
    () =>
      [...catalog.byKey.values()].find(
        (d) => (d.custom?.group ?? d.group) === 'pkg.crossplane.io' && d.kind === 'Provider'
      ),
    [catalog]
  )

  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const [nodesRes, nodeMetrics, podMetrics, podsRes, eventsRes, depRes, stsRes, dsRes, pvcRes, pvRes] =
          await Promise.all([
            api.listResource('nodes'),
            api.getMetrics('nodes'),
            api.getMetrics('pods'),
            api.listResource('pods'),
            api.listResource('events'),
            api.listResource('deployments'),
            api.listResource('statefulsets'),
            api.listResource('daemonsets'),
            api.listResource('persistentvolumeclaims'),
            api.listResource('persistentvolumes')
          ])
        const [argoRes, xpRes, helmRes] = await Promise.all([
          argoDef?.custom ? api.listCustom(argoDef.custom).catch(() => null) : Promise.resolve(null),
          xpDef?.custom ? api.listCustom(xpDef.custom).catch(() => null) : Promise.resolve(null),
          api.listResource('releases').catch(() => null)
        ])
        if (disposed) return

        // ---- nodes / capacity ----
        let cpuTotal = 0
        let memTotal = 0
        let podCapacity = 0
        let nodesReady = 0
        const versions = new Set<string>()
        for (const n of nodesRes.items) {
          cpuTotal += parseCpuToMillicores(getByPath(n, 'status.allocatable.cpu') as string)
          memTotal += parseMemoryToBytes(getByPath(n, 'status.allocatable.memory') as string)
          podCapacity += Number(getByPath(n, 'status.allocatable.pods') ?? 0)
          const conds = (getByPath(n, 'status.conditions') as Array<{ type?: string; status?: string }>) ?? []
          if (conds.some((c) => c.type === 'Ready' && c.status === 'True')) nodesReady++
          const v = getByPath(n, 'status.nodeInfo.kubeletVersion') as string
          if (v) versions.add(v)
        }
        const nodeUsage = new Map<string, { cpu: number; memory: number }>()
        let cpuUsed = 0
        let memUsed = 0
        for (const s of nodeMetrics.samples) {
          cpuUsed += s.cpu
          memUsed += s.memory
          nodeUsage.set(s.name, { cpu: s.cpu, memory: s.memory })
        }

        // ---- pods: problems, pending, restarts, requests, per-node, per-ns ----
        const podUsage = new Map<string, { cpu: number; memory: number }>()
        for (const s of podMetrics.samples) podUsage.set(`${s.namespace}/${s.name}`, { cpu: s.cpu, memory: s.memory })

        const problems: K8sObject[] = []
        const pending: K8sObject[] = []
        const podsPerNode = new Map<string, number>()
        const nsAgg = new Map<string, { pods: number; cpu: number }>()
        let cpuReq = 0
        let memReq = 0
        for (const p of podsRes.items) {
          const st = podStatus(p)
          if (PROBLEM_STATES.test(st)) problems.push(p)
          else if (PENDING_STATES.test(st)) pending.push(p)
          const node = getByPath(p, 'spec.nodeName') as string
          if (node) podsPerNode.set(node, (podsPerNode.get(node) ?? 0) + 1)
          const req = podRequests(p)
          cpuReq += req.cpu
          memReq += req.memory
          const ns = p.metadata?.namespace ?? '-'
          const agg = nsAgg.get(ns) ?? { pods: 0, cpu: 0 }
          agg.pods++
          agg.cpu += podUsage.get(podKey(p))?.cpu ?? 0
          nsAgg.set(ns, agg)
        }

        const withUsage = podsRes.items
          .map((pod) => ({ pod, u: podUsage.get(podKey(pod)) }))
          .filter((x) => x.u) as Array<{ pod: K8sObject; u: { cpu: number; memory: number } }>
        const topCpu = [...withUsage]
          .sort((a, b) => b.u.cpu - a.u.cpu)
          .slice(0, TOP_N)
          .map((x) => ({ pod: x.pod, value: x.u.cpu }))
        const topMem = [...withUsage]
          .sort((a, b) => b.u.memory - a.u.memory)
          .slice(0, TOP_N)
          .map((x) => ({ pod: x.pod, value: x.u.memory }))

        const restarters = podsRes.items
          .filter((p) => restartsOf(p) > 0)
          .sort((a, b) => restartsOf(b) - restartsOf(a))
          .slice(0, TOP_N)

        // ---- workloads not fully available ----
        const degraded: Snapshot['degraded'] = []
        const addDegraded = (items: K8sObject[], key: string, readyPath: string, desiredPath: string): void => {
          for (const o of items) {
            const ready = Number(getByPath(o, readyPath) ?? 0)
            const desired = Number(getByPath(o, desiredPath) ?? 0)
            if (desired > 0 && ready < desired) degraded.push({ def: key, obj: o, ready, desired })
          }
        }
        addDegraded(depRes.items, 'deployments', 'status.readyReplicas', 'spec.replicas')
        addDegraded(stsRes.items, 'statefulsets', 'status.readyReplicas', 'spec.replicas')
        addDegraded(dsRes.items, 'daemonsets', 'status.numberReady', 'status.desiredNumberScheduled')

        // ---- storage ----
        let pvcPending = 0
        let pvcBound = 0
        let storageTotal = 0
        for (const c of pvcRes.items) {
          const phase = getByPath(c, 'status.phase') as string
          if (phase === 'Bound') pvcBound++
          else pvcPending++
          storageTotal += parseMemoryToBytes(getByPath(c, 'status.capacity.storage') as string)
        }
        const pvUnbound = pvRes.items.filter((v) => (getByPath(v, 'status.phase') as string) !== 'Bound').length

        // ---- gitops / helm ----
        const argoApps = argoRes?.items ?? []
        const argoBad = argoApps.filter(
          (a) =>
            (getByPath(a, 'status.sync.status') as string) === 'OutOfSync' ||
            ['Degraded', 'Missing', 'Unknown'].includes((getByPath(a, 'status.health.status') as string) ?? '')
        )
        const argoRollup = { synced: 0, outOfSync: 0, healthy: 0, progressing: 0, degraded: 0, missing: 0, total: argoApps.length }
        for (const a of argoApps) {
          const sync = (getByPath(a, 'status.sync.status') as string) ?? ''
          const health = (getByPath(a, 'status.health.status') as string) ?? ''
          if (sync === 'Synced') argoRollup.synced++
          else if (sync === 'OutOfSync') argoRollup.outOfSync++
          if (health === 'Healthy') argoRollup.healthy++
          else if (health === 'Progressing') argoRollup.progressing++
          else if (health === 'Degraded') argoRollup.degraded++
          else if (health === 'Missing') argoRollup.missing++
        }
        // A sync that ERRORED is a different failure from simply being adrift.
        const argoFailedOps = argoApps.filter((a) => /Failed|Error/i.test(argoOpPhase(a)))
        const argoRecent = argoApps
          .filter((a) => argoOpFinished(a))
          .sort((a, b) => Date.parse(argoOpFinished(b)) - Date.parse(argoOpFinished(a)))
          .slice(0, TOP_N)
        const helmBad = (helmRes?.items ?? []).filter((r) => {
          const s = getByPath(r, 'status')
          return typeof s === 'string' && s !== 'deployed'
        })

        setSnap({
          cpuUsed,
          cpuTotal,
          memUsed,
          memTotal,
          cpuReq,
          memReq,
          podCount: podsRes.items.length,
          podCapacity,
          nodes: nodesRes.items,
          nodesReady,
          nodeUsage,
          podsPerNode,
          problems: problems.sort((a, b) => (a.metadata?.namespace ?? '').localeCompare(b.metadata?.namespace ?? '')),
          pending,
          restarters,
          topCpu,
          topMem,
          degraded,
          namespaces: [...nsAgg.entries()]
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.pods - a.pods)
            .slice(0, TOP_N),
          warnings: eventsRes.items
            .filter((e) => (getByPath(e, 'type') as string) === 'Warning')
            .sort((a, b) => Date.parse(eventTs(b)) - Date.parse(eventTs(a)))
            .slice(0, 10),
          pvcPending,
          pvcBound,
          pvUnbound,
          storageTotal,
          versions: [...versions],
          argoBad,
          argoRollup,
          argoFailedOps,
          argoRecent,
          xpProviders: xpRes?.items ?? [],
          helmBad,
          metricsOk: nodeMetrics.available
        })
      } catch {
        /* cluster hiccup - keep the last snapshot */
      }
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      disposed = true
      clearInterval(t)
    }
  }, [contextVersion, argoDef])

  // ---- new-item alerts -------------------------------------------------
  // Flash a panel only when a key it has never shown before appears, so a
  // steady-state problem doesn't blink forever.
  const [alertsOn, setAlertsOn] = useState(loadPrefs().alertFlash)
  const [flashing, setFlashing] = useState<Record<string, boolean>>({})
  const seenRef = useRef<Record<string, Set<string>>>({})
  const firstRunRef = useRef(true)
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const silence = (panel: string): void => {
    clearTimeout(timersRef.current[panel])
    setFlashing((f) => ({ ...f, [panel]: false }))
  }

  useEffect(() => {
    if (!snap) return
    const groups: Record<string, K8sObject[]> = {
      problems: snap.problems,
      warnings: snap.warnings,
      degraded: snap.degraded.map((d) => d.obj),
      pending: snap.pending,
      gitops: snap.argoBad,
      syncfail: snap.argoFailedOps
    }
    const wasFirst = firstRunRef.current
    firstRunRef.current = false
    for (const [panel, items] of Object.entries(groups)) {
      const keys = new Set(items.map((o) => o.metadata?.uid ?? `${o.metadata?.namespace}/${o.metadata?.name}`))
      const seen = seenRef.current[panel]
      // On the very first snapshot just record what's there - no alarm for
      // pre-existing problems the moment the dashboard opens.
      if (!wasFirst && seen && alertsOn) {
        const isNew = [...keys].some((k) => !seen.has(k))
        if (isNew) {
          setFlashing((f) => ({ ...f, [panel]: true }))
          clearTimeout(timersRef.current[panel])
          timersRef.current[panel] = setTimeout(
            () => setFlashing((f) => ({ ...f, [panel]: false })),
            FLASH_MS
          )
        }
      }
      seenRef.current[panel] = keys
    }
  }, [snap, alertsOn])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t)
    }
  }, [])

  function toggleAlerts(): void {
    setAlertsOn((on) => {
      const next = !on
      savePrefs({ alertFlash: next })
      if (!next) {
        for (const t of Object.values(timersRef.current)) clearTimeout(t)
        setFlashing({})
      }
      return next
    })
  }

  // ---- dashboard layout (drag to reorder, hide panels, persisted) --------
  const [editing, setEditing] = useState(false)
  const [layout, setLayout] = useState(() => {
    const saved = loadPrefs().dashboardLayout
    return {
      order: saved?.order?.length ? saved.order : [...DEFAULT_PANEL_ORDER],
      hidden: saved?.hidden ?? []
    }
  })
  const dragIdRef = useRef<string | null>(null)

  // New panels shipped in an update must appear even for users with a saved
  // layout, so append anything the saved order has never seen.
  useEffect(() => {
    setLayout((l) => {
      const missing = DEFAULT_PANEL_ORDER.filter((id) => !l.order.includes(id))
      return missing.length ? { ...l, order: [...l.order, ...missing] } : l
    })
  }, [])

  const persist = (next: { order: string[]; hidden: string[] }): void => {
    setLayout(next)
    savePrefs({ dashboardLayout: next })
  }

  const layoutCtx: LayoutState = {
    editing,
    order: layout.order,
    hidden: layout.hidden,
    onDragStart: (id) => {
      dragIdRef.current = id
    },
    onDropOn: (targetId) => {
      const from = dragIdRef.current
      dragIdRef.current = null
      if (!from || from === targetId) return
      const order = layout.order.filter((x) => x !== from)
      const at = order.indexOf(targetId)
      order.splice(at < 0 ? order.length : at, 0, from)
      persist({ ...layout, order })
    },
    toggleHidden: (id) =>
      persist({
        ...layout,
        hidden: layout.hidden.includes(id) ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id]
      })
  }

  const resetLayout = (): void => persist({ order: [...DEFAULT_PANEL_ORDER], hidden: [] })

  const podsDef = useMemo(() => getResourceDef('pods'), [])
  const openPod = (p: K8sObject, tab?: string): void => {
    if (podsDef) onOpen(podsDef, p, tab)
  }

  const pct = (used: number, total: number): number | null => (total > 0 ? Math.round((used / total) * 100) : null)
  const cpuPct = snap ? pct(snap.cpuUsed, snap.cpuTotal) : null
  const memPct = snap ? pct(snap.memUsed, snap.memTotal) : null
  const cpuReqPct = snap ? pct(snap.cpuReq, snap.cpuTotal) : null
  const memReqPct = snap ? pct(snap.memReq, snap.memTotal) : null
  const podPct = snap ? pct(snap.podCount, snap.podCapacity) : null
  const noMetrics = clusterInfo?.metricsAvailable === false || (snap && !snap.metricsOk)
  const dash = (v: number | null): string => (v === null ? (noMetrics ? 'n/a' : '...') : `${v}%`)

  return (
    <div className="overview">
      {/* version skew banner */}
      {snap && snap.versions.length > 1 && (
        <div className="ov-skew">
          <Icon name="node" size={13} /> Kubelet version skew across nodes: {snap.versions.join(', ')}
        </div>
      )}

      <div className="ov-gauges">
        <Gauge label="CPU used" value={dash(cpuPct)} pct={cpuPct} trend={cpuTrend} />
        <Gauge label="Memory used" value={dash(memPct)} pct={memPct} trend={memTrend} />
        <Gauge label="CPU requested" value={cpuReqPct === null ? '...' : `${cpuReqPct}%`} pct={cpuReqPct} />
        <Gauge label="Memory requested" value={memReqPct === null ? '...' : `${memReqPct}%`} pct={memReqPct} />
        <Gauge
          label="Pod slots"
          value={snap ? `${snap.podCount}/${snap.podCapacity || '-'}` : '...'}
          pct={podPct}
        />
        <Gauge
          label="Nodes ready"
          value={snap ? `${snap.nodesReady}/${snap.nodes.length}` : '...'}
          pct={snap && snap.nodes.length ? (snap.nodesReady / snap.nodes.length) * 100 : 0}
          // inverted: any node missing is critical, however high the bar sits
          level={!snap ? 'ok' : snap.nodesReady < snap.nodes.length ? 'crit' : 'ok'}
        />
      </div>
      <div className="ov-legend">
        <span className="ov-legend__item">
          <i className="ov-legend__dot is-ok" /> under {WARN_AT}%
        </span>
        <span className="ov-legend__item">
          <i className="ov-legend__dot is-warn" /> warning {WARN_AT}-{CRIT_AT}%
        </span>
        <span className="ov-legend__item">
          <i className="ov-legend__dot is-crit" /> critical {CRIT_AT}%+
        </span>
        <button
          className={`ov-alert-toggle${alertsOn ? ' is-on' : ''}`}
          onClick={toggleAlerts}
          title={alertsOn ? 'Alerts flash when new problems appear - click to turn off' : 'Alert flashing is off'}
        >
          <Icon name={alertsOn ? 'event' : 'close'} size={12} /> {alertsOn ? 'Alerts on' : 'Alerts off'}
        </button>
        <button
          className={`ov-alert-toggle${editing ? ' is-on' : ''}`}
          onClick={() => setEditing((e) => !e)}
          title="Drag panels to reorder, click x to hide"
        >
          <Icon name={editing ? 'check' : 'sliders'} size={12} /> {editing ? 'Done' : 'Arrange'}
        </button>
        {editing && (
          <button className="ov-alert-toggle" onClick={resetLayout} title="Restore the default arrangement">
            <Icon name="refresh" size={12} /> Reset
          </button>
        )}
      </div>
      {editing && (
        <div className="ov-edit-hint">
          Drag panels to reorder · click <b>x</b> to hide · hidden panels appear dimmed with <b>+</b> · the layout is
          saved automatically
        </div>
      )}

      <div className="overview__grid">
        {TILES.map(([key, label]) => {
          const c = counts[key]
          return (
            <button className="tile" key={key} onClick={() => onSelect(key)}>
              <div className="tile__label">{label}</div>
              <div className="tile__value">{c === undefined ? '...' : c}</div>
            </button>
          )
        })}
      </div>

      <LayoutCtx.Provider value={layoutCtx}>
      <div className={`ov-panels${editing ? ' is-editing' : ''}`}>
        {/* ---------- problems ---------- */}
        <Panel id="problems" title="Problems" flashing={flashing.problems} onSilence={() => silence('problems')} icon="pod" severity="error" count={snap ? snap.problems.length : null}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.problems.length === 0 ? (
            <div className="empty-hint">No unhealthy pods.</div>
          ) : (
            <ul className="ov-list">
              {snap.problems.slice(0, 8).map((p) => {
                const st = podStatus(p)
                const since = problemSince(p)
                return (
                  <li key={p.metadata?.uid}>
                    <button className="ov-row" onClick={() => openPod(p, 'logs')}>
                      <span className="ov-row__age" title={absolute(since)}>
                        {since ? humanDuration(since, now) : '-'}
                      </span>
                      <span className={`status-dot status-dot--${statusVariant(st)}`} />
                      <span className="ov-row__name">
                        {p.metadata?.namespace}/{p.metadata?.name}
                      </span>
                      <span className="ov-row__meta">{st}</span>
                    </button>
                  </li>
                )
              })}
              {snap.problems.length > 8 && (
                <li>
                  <button className="ov-row ov-row--more" onClick={() => onSelect('pods')}>
                    ... and {snap.problems.length - 8} more - open Pods
                  </button>
                </li>
              )}
            </ul>
          )}
        </Panel>

        {/* ---------- warning events ---------- */}
        <Panel id="warnings" title="Warning events" flashing={flashing.warnings} onSilence={() => silence('warnings')} icon="event" severity="warn" count={snap ? snap.warnings.length : null}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.warnings.length === 0 ? (
            <div className="empty-hint">No recent warnings.</div>
          ) : (
            <ul className="ov-list">
              {snap.warnings.map((e) => (
                <li key={e.metadata?.uid}>
                  <button className="ov-row" onClick={() => onSelect('events')}>
                    <span className="ov-row__age" title={absolute(eventTs(e))}>
                      {humanDuration(eventTs(e), now)}
                    </span>
                    <span className="status-dot status-dot--pending" />
                    <span className="ov-row__name">
                      {String(getByPath(e, 'involvedObject.kind') ?? '')}/
                      {String(getByPath(e, 'involvedObject.name') ?? '')}
                    </span>
                    <span className="ov-row__meta is-warn" title={String(getByPath(e, 'message') ?? '')}>
                      {String(getByPath(e, 'reason') ?? '')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------- workloads not fully available ---------- */}
        <Panel id="degraded" title="Workloads degraded" flashing={flashing.degraded} onSilence={() => silence('degraded')} icon="deploy" severity="error" count={snap ? snap.degraded.length : null}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.degraded.length === 0 ? (
            <div className="empty-hint">Every workload is at full strength.</div>
          ) : (
            <ul className="ov-list">
              {snap.degraded.slice(0, 8).map((d) => {
                const def = catalog.byKey.get(d.def)
                return (
                  <li key={`${d.def}/${d.obj.metadata?.uid}`}>
                    <button className="ov-row" onClick={() => def && onOpen(def, d.obj)}>
                      <span className="ov-row__age">
                        {d.ready}/{d.desired}
                      </span>
                      <span className="status-dot status-dot--failed" />
                      <span className="ov-row__name">
                        {d.obj.metadata?.namespace}/{d.obj.metadata?.name}
                      </span>
                      <span className="ov-row__meta">{def?.kind ?? d.def}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        {/* ---------- pending / unschedulable ---------- */}
        <Panel id="pending" title="Pending pods" flashing={flashing.pending} onSilence={() => silence('pending')} icon="pod" severity="warn" count={snap ? snap.pending.length : null}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.pending.length === 0 ? (
            <div className="empty-hint">Nothing waiting to schedule.</div>
          ) : (
            <ul className="ov-list">
              {snap.pending.slice(0, 8).map((p) => (
                <li key={p.metadata?.uid}>
                  <button className="ov-row" onClick={() => openPod(p, 'events')}>
                    <span className="ov-row__age" title={absolute(problemSince(p))}>
                      {humanDuration(problemSince(p), now)}
                    </span>
                    <span className="status-dot status-dot--pending" />
                    <span className="ov-row__name">
                      {p.metadata?.namespace}/{p.metadata?.name}
                    </span>
                    <span className="ov-row__meta is-warn">{podStatus(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------- top CPU ---------- */}
        <Panel id="topcpu" title="Top CPU" icon="chart" count={undefined}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.topCpu.length === 0 ? (
            <div className="empty-hint">{noMetrics ? 'metrics-server not available.' : 'No samples yet.'}</div>
          ) : (
            <ul className="ov-list">
              {snap.topCpu.map(({ pod, value }) => (
                <li key={pod.metadata?.uid}>
                  <button className="ov-row" onClick={() => openPod(pod)}>
                    <span className="ov-row__name">
                      {pod.metadata?.namespace}/{pod.metadata?.name}
                    </span>
                    <Bar pct={(value / (snap.topCpu[0].value || 1)) * 100} level="ok" />
                    <span className="ov-row__val">{formatCpu(value)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------- top memory ---------- */}
        <Panel id="topmem" title="Top memory" icon="chart" count={undefined}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.topMem.length === 0 ? (
            <div className="empty-hint">{noMetrics ? 'metrics-server not available.' : 'No samples yet.'}</div>
          ) : (
            <ul className="ov-list">
              {snap.topMem.map(({ pod, value }) => (
                <li key={pod.metadata?.uid}>
                  <button className="ov-row" onClick={() => openPod(pod)}>
                    <span className="ov-row__name">
                      {pod.metadata?.namespace}/{pod.metadata?.name}
                    </span>
                    <Bar pct={(value / (snap.topMem[0].value || 1)) * 100} level="ok" />
                    <span className="ov-row__val">{formatMemory(value)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------- restarts ---------- */}
        <Panel id="restarts" title="Most restarts" icon="refresh" count={undefined}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.restarters.length === 0 ? (
            <div className="empty-hint">No pod has restarted.</div>
          ) : (
            <ul className="ov-list">
              {snap.restarters.map((p) => {
                const n = restartsOf(p)
                return (
                  <li key={p.metadata?.uid}>
                    <button className="ov-row" onClick={() => openPod(p, 'logs')}>
                      <span className={`ov-row__age${n > 5 ? ' is-warn' : ''}`}>{n}x</span>
                      <span className="ov-row__name">
                        {p.metadata?.namespace}/{p.metadata?.name}
                      </span>
                      <span className="ov-row__meta">{podStatus(p)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        {/* ---------- nodes ---------- */}
        <Panel id="nodes" title="Nodes" icon="node" count={undefined} wide>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : (
            <ul className="ov-list">
              {snap.nodes.map((n) => {
                const name = n.metadata?.name ?? ''
                const alloc = parseCpuToMillicores(getByPath(n, 'status.allocatable.cpu') as string)
                const allocMem = parseMemoryToBytes(getByPath(n, 'status.allocatable.memory') as string)
                const u = snap.nodeUsage.get(name)
                const conds = (getByPath(n, 'status.conditions') as Array<{ type?: string; status?: string }>) ?? []
                const bad = conds.filter((c) => c.type !== 'Ready' && c.status === 'True').map((c) => c.type)
                const notReady = !conds.some((c) => c.type === 'Ready' && c.status === 'True')
                const cp = u && alloc ? Math.round((u.cpu / alloc) * 100) : null
                const mp = u && allocMem ? Math.round((u.memory / allocMem) * 100) : null
                // pod slots are a hard scheduling limit of their own (kubelet
                // maxPods, 110 by default) - a node can be idle yet unschedulable
                const podsUsed = snap.podsPerNode.get(name) ?? 0
                const podsMax = Number(getByPath(n, 'status.allocatable.pods') ?? 0)
                const pp = podsMax ? Math.round((podsUsed / podsMax) * 100) : null
                const nodeDef = catalog.byKey.get('nodes')
                return (
                  <li key={n.metadata?.uid}>
                    <button className="ov-row" onClick={() => nodeDef && onOpen(nodeDef, n)}>
                      <span className={`status-dot status-dot--${notReady ? 'failed' : 'running'}`} />
                      <span className="ov-row__name">{name}</span>
                      <span className="ov-node-metric" title={`${podsUsed} of ${podsMax} pod slots used`}>
                        pods <b className={`is-${levelOf(pp)}`}>{podsUsed}/{podsMax || '-'}{pp === null ? '' : ` (${pp}%)`}</b>{' '}
                        <Bar pct={pp ?? 0} />
                      </span>
                      <span className="ov-node-metric">
                        cpu <b className={`is-${levelOf(cp)}`}>{cp === null ? '-' : `${cp}%`}</b> <Bar pct={cp ?? 0} />
                      </span>
                      <span className="ov-node-metric">
                        mem <b className={`is-${levelOf(mp)}`}>{mp === null ? '-' : `${mp}%`}</b> <Bar pct={mp ?? 0} />
                      </span>
                      {(bad.length > 0 || notReady) && (
                        <span className="ov-row__meta is-warn">{notReady ? 'NotReady' : bad.join(', ')}</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        {/* ---------- storage ---------- */}
        <Panel id="storage" title="Storage" icon="volume" count={undefined}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : (
            <ul className="ov-list">
              <li>
                <button className="ov-row" onClick={() => onSelect('persistentvolumeclaims')}>
                  <span className="status-dot status-dot--running" />
                  <span className="ov-row__name">Claims bound</span>
                  <span className="ov-row__meta">{snap.pvcBound}</span>
                </button>
              </li>
              <li>
                <button className="ov-row" onClick={() => onSelect('persistentvolumeclaims')}>
                  <span className={`status-dot status-dot--${snap.pvcPending ? 'pending' : 'running'}`} />
                  <span className="ov-row__name">Claims not bound</span>
                  <span className={`ov-row__meta${snap.pvcPending ? ' is-warn' : ''}`}>{snap.pvcPending}</span>
                </button>
              </li>
              <li>
                <button className="ov-row" onClick={() => onSelect('persistentvolumes')}>
                  <span className={`status-dot status-dot--${snap.pvUnbound ? 'pending' : 'running'}`} />
                  <span className="ov-row__name">Volumes unbound</span>
                  <span className={`ov-row__meta${snap.pvUnbound ? ' is-warn' : ''}`}>{snap.pvUnbound}</span>
                </button>
              </li>
              <li>
                <button className="ov-row" onClick={() => onSelect('persistentvolumeclaims')}>
                  <span className="status-dot" />
                  <span className="ov-row__name">Requested capacity</span>
                  <span className="ov-row__meta">{formatMemory(snap.storageTotal)}</span>
                </button>
              </li>
            </ul>
          )}
        </Panel>

        {/* ---------- namespaces ---------- */}
        <Panel id="namespaces" title="Busiest namespaces" icon="namespace" count={undefined}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : (
            <ul className="ov-list">
              {snap.namespaces.map((ns) => (
                <li key={ns.name}>
                  <button className="ov-row" onClick={() => onSelect('namespaces')}>
                    <span className="ov-row__name">{ns.name}</span>
                    <Bar pct={(ns.pods / (snap.namespaces[0]?.pods || 1)) * 100} level="ok" />
                    <span className="ov-row__val">{ns.pods} pods</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------- gitops (only when ArgoCD is installed) ---------- */}
        {argoDef && (
          <Panel id="gitops" title="GitOps drift" flashing={flashing.gitops} onSilence={() => silence('gitops')} icon="argo" severity="warn" count={snap ? snap.argoBad.length : null}>
            {!snap ? (
              <div className="empty-hint">Loading...</div>
            ) : snap.argoBad.length === 0 ? (
              <div className="empty-hint">All Applications synced and healthy.</div>
            ) : (
              <ul className="ov-list">
                {snap.argoBad.slice(0, 8).map((a) => (
                  <li key={a.metadata?.uid}>
                    <button className="ov-row" onClick={() => onOpen(argoDef, a)}>
                      <span className="status-dot status-dot--pending" />
                      <span className="ov-row__name">
                        {a.metadata?.namespace}/{a.metadata?.name}
                      </span>
                      <span className="ov-row__meta is-warn">
                        {String(getByPath(a, 'status.sync.status') ?? '')} ·{' '}
                        {String(getByPath(a, 'status.health.status') ?? '')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {/* ---------- argo: fleet rollup ---------- */}
        {argoDef && snap && snap.argoRollup.total > 0 && (
          <Panel id="gitopsfleet" title="GitOps fleet" icon="argo" wide count={snap.argoRollup.total}>
            <div className="ov-rollup">
              <div className="ov-rollup__group">
                <span className="ov-rollup__label">Sync</span>
                <div className="ov-segbar" title={`${snap.argoRollup.synced} synced, ${snap.argoRollup.outOfSync} out of sync`}>
                  <span
                    className="ov-seg is-ok"
                    style={{ width: `${(snap.argoRollup.synced / snap.argoRollup.total) * 100}%` }}
                  />
                  <span
                    className="ov-seg is-warn"
                    style={{ width: `${(snap.argoRollup.outOfSync / snap.argoRollup.total) * 100}%` }}
                  />
                </div>
                <span className="ov-rollup__counts">
                  <b className="is-ok">{snap.argoRollup.synced}</b> synced ·{' '}
                  <b className={snap.argoRollup.outOfSync ? 'is-warn' : ''}>{snap.argoRollup.outOfSync}</b> drifted
                </span>
              </div>
              <div className="ov-rollup__group">
                <span className="ov-rollup__label">Health</span>
                <div className="ov-segbar">
                  <span
                    className="ov-seg is-ok"
                    style={{ width: `${(snap.argoRollup.healthy / snap.argoRollup.total) * 100}%` }}
                  />
                  <span
                    className="ov-seg is-warn"
                    style={{ width: `${(snap.argoRollup.progressing / snap.argoRollup.total) * 100}%` }}
                  />
                  <span
                    className="ov-seg is-crit"
                    style={{
                      width: `${((snap.argoRollup.degraded + snap.argoRollup.missing) / snap.argoRollup.total) * 100}%`
                    }}
                  />
                </div>
                <span className="ov-rollup__counts">
                  <b className="is-ok">{snap.argoRollup.healthy}</b> healthy ·{' '}
                  <b className={snap.argoRollup.progressing ? 'is-warn' : ''}>{snap.argoRollup.progressing}</b>{' '}
                  progressing ·{' '}
                  <b className={snap.argoRollup.degraded + snap.argoRollup.missing ? 'is-crit' : ''}>
                    {snap.argoRollup.degraded + snap.argoRollup.missing}
                  </b>{' '}
                  degraded
                </span>
              </div>
            </div>
          </Panel>
        )}

        {/* ---------- argo: failed sync operations ---------- */}
        {argoDef && (
          <Panel
            id="syncfail"
            title="Sync failures"
            icon="argo"
            severity="error"
            flashing={flashing.syncfail}
            onSilence={() => silence('syncfail')}
            count={snap ? snap.argoFailedOps.length : null}
          >
            {!snap ? (
              <div className="empty-hint">Loading...</div>
            ) : snap.argoFailedOps.length === 0 ? (
              <div className="empty-hint">No failed sync operations.</div>
            ) : (
              <ul className="ov-list">
                {snap.argoFailedOps.slice(0, 8).map((a) => (
                  <li key={a.metadata?.uid}>
                    <button className="ov-row" onClick={() => onOpen(argoDef, a)}>
                      <span className="ov-row__age" title={absolute(argoOpFinished(a))}>
                        {argoOpFinished(a) ? humanDuration(argoOpFinished(a), now) : '-'}
                      </span>
                      <span className="status-dot status-dot--failed" />
                      <span className="ov-row__name">{a.metadata?.name}</span>
                      <span
                        className="ov-row__meta is-crit"
                        title={String(getByPath(a, 'status.operationState.message') ?? '')}
                      >
                        {argoOpPhase(a)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {/* ---------- argo: recent syncs ---------- */}
        {argoDef && (
          <Panel id="recentsync" title="Recent syncs" icon="git-branch" count={undefined}>
            {!snap ? (
              <div className="empty-hint">Loading...</div>
            ) : snap.argoRecent.length === 0 ? (
              <div className="empty-hint">No sync history yet.</div>
            ) : (
              <ul className="ov-list">
                {snap.argoRecent.map((a) => {
                  const phase = argoOpPhase(a)
                  const ok = /Succeeded/i.test(phase)
                  return (
                    <li key={a.metadata?.uid}>
                      <button className="ov-row" onClick={() => onOpen(argoDef, a)}>
                        <span className="ov-row__age" title={absolute(argoOpFinished(a))}>
                          {humanDuration(argoOpFinished(a), now)}
                        </span>
                        <span className={`status-dot status-dot--${ok ? 'running' : 'failed'}`} />
                        <span className="ov-row__name">{a.metadata?.name}</span>
                        <span className={`ov-row__meta${ok ? '' : ' is-crit'}`}>
                          {String(getByPath(a, 'status.sync.revision') ?? '').slice(0, 7) || phase}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        )}

        {/* ---------- crossplane providers ---------- */}
        {xpDef && (
          <Panel
            id="crossplane"
            title="Crossplane providers"
            icon="crd"
            severity="error"
            count={snap ? snap.xpProviders.filter((p) => conditionOf(p, 'Healthy') !== 'True').length : null}
          >
            {!snap ? (
              <div className="empty-hint">Loading...</div>
            ) : snap.xpProviders.length === 0 ? (
              <div className="empty-hint">No providers installed.</div>
            ) : (
              <ul className="ov-list">
                {snap.xpProviders.map((p) => {
                  // Crossplane reports these as conditions; older packages use
                  // plain status fields, so accept either.
                  const healthy =
                    conditionOf(p, 'Healthy') === 'True' || String(getByPath(p, 'status.healthy')) === 'True'
                  const installed =
                    conditionOf(p, 'Installed') === 'True' || String(getByPath(p, 'status.installed')) === 'True'
                  return (
                    <li key={p.metadata?.uid}>
                      <button className="ov-row" onClick={() => onOpen(xpDef, p)}>
                        <span className={`status-dot status-dot--${healthy ? 'running' : 'failed'}`} />
                        <span className="ov-row__name">{p.metadata?.name}</span>
                        <span className={`ov-row__meta${healthy ? '' : ' is-crit'}`}>
                          {installed ? 'installed' : 'not installed'} · {healthy ? 'healthy' : 'unhealthy'}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        )}

        {/* ---------- helm ---------- */}
        <Panel id="helm" title="Helm releases" icon="release" severity="warn" count={snap ? snap.helmBad.length : null}>
          {!snap ? (
            <div className="empty-hint">Loading...</div>
          ) : snap.helmBad.length === 0 ? (
            <div className="empty-hint">All releases deployed.</div>
          ) : (
            <ul className="ov-list">
              {snap.helmBad.slice(0, 8).map((r) => (
                <li key={`${r.metadata?.namespace}/${r.metadata?.name}`}>
                  <button className="ov-row" onClick={() => onSelect('releases')}>
                    <span className="status-dot status-dot--pending" />
                    <span className="ov-row__name">
                      {r.metadata?.namespace}/{r.metadata?.name}
                    </span>
                    <span className="ov-row__meta is-warn">{String(getByPath(r, 'status') ?? '')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      </LayoutCtx.Provider>
    </div>
  )
}
