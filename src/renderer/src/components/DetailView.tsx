import React, { useEffect, useMemo, useState } from 'react'
import yaml from 'js-yaml'
import { getResourceDef, type ResourceDef } from '@shared/catalog'
import type { K8sObject, MutationResult } from '@shared/types'
import { api } from '../api'
import { useToast } from '../state/toast'
import { getByPath } from '../lib/getByPath'
import { getSelector, matchesSelector } from '../lib/owned'
import { diffLines, diffStat } from '../lib/lineDiff'
import { objectToTemplateYaml, saveUserTemplate } from '../lib/templates'
import { useResourceData, metricKey, type MetricsMap } from '../hooks/useResourceData'
import { Icon } from './Icon'
import { YamlEditor } from './YamlEditor'
import { ResourceTable } from './ResourceTable'
import { EventsPanel } from './panels/EventsPanel'
import { LogsPanel } from './panels/LogsPanel'
import { WorkloadLogsPanel } from './panels/WorkloadLogsPanel'
import { TerminalPanel } from './panels/TerminalPanel'
import { ForwardPanel } from './panels/ForwardPanel'
import { SpecificationsPanel } from './panels/SpecificationsPanel'
import { LabelsPanel } from './panels/LabelsPanel'
import { ImagesPanel } from './panels/ImagesPanel'
import { DescribePanel } from './panels/DescribePanel'
import { RelatedPanel } from './panels/RelatedPanel'
import { FilesPanel } from './panels/FilesPanel'
import { ConfirmModal } from './modals/ConfirmModal'
import { ScaleModal } from './modals/ScaleModal'
import { ContextDiffModal } from './modals/ContextDiffModal'
import { Spark } from './cells/Spark'
import { historyFor, onMetricsHistory } from '../lib/metricsHistory'
import { formatCpu, formatMemory } from '../lib/format'

type Tab =
  | 'status'
  | 'pods'
  | 'describe'
  | 'specifications'
  | 'view'
  | 'labels'
  | 'related'
  | 'logs'
  | 'terminal'
  | 'files'
  | 'ports'
  | 'images'
  | 'events'

const RESTARTABLE = new Set(['deployments', 'statefulsets', 'daemonsets'])
const SCALABLE = new Set(['deployments', 'statefulsets', 'replicasets', 'replicationcontrollers'])

const TAB_ICON: Record<Tab, string> = {
  status: 'heart',
  pods: 'pod',
  describe: 'list',
  specifications: 'sliders',
  view: 'code',
  labels: 'tag',
  related: 'git-branch',
  logs: 'logs',
  terminal: 'terminal',
  files: 'box',
  ports: 'forward',
  images: 'layers',
  events: 'list'
}
const TAB_LABEL: Record<Tab, string> = {
  status: 'Status',
  pods: 'Pods',
  describe: 'Describe',
  specifications: 'Specifications',
  view: 'View',
  labels: 'Labels',
  related: 'Related',
  logs: 'Logs',
  terminal: 'Terminal',
  files: 'Files',
  ports: 'Ports',
  images: 'Images',
  events: 'Events'
}

interface Props {
  def: ResourceDef
  obj: K8sObject
  now: number
  theme: 'dark' | 'light'
  contextVersion: number
  initialTab?: Tab
  readOnly?: boolean
  onBack: () => void
  /** pin this object into the side-by-side pane (desktop; omitted in the pane itself) */
  onSplit?: () => void
  onDrill: (def: ResourceDef, obj: K8sObject) => void
  onChanged: () => void
}

function toYaml(obj: K8sObject): string {
  const clone = JSON.parse(JSON.stringify(obj)) as K8sObject
  if (clone.metadata) {
    const m = clone.metadata as Record<string, unknown>
    delete m.managedFields
    // SSA has its own conflict handling; a stale resourceVersion in the patch
    // would only add spurious optimistic-locking failures.
    delete m.resourceVersion
  }
  try {
    return yaml.dump(clone, { noRefs: true, sortKeys: false, lineWidth: 140 })
  } catch {
    return JSON.stringify(clone, null, 2)
  }
}
function podContainers(obj: K8sObject): string[] {
  const spec = (obj.spec ?? {}) as { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }> }
  return [...(spec.containers ?? []), ...(spec.initContainers ?? [])].map((c) => c.name)
}
function podPorts(obj: K8sObject): number[] {
  const spec = (obj.spec ?? {}) as { containers?: Array<{ ports?: Array<{ containerPort?: number }> }> }
  const set = new Set<number>()
  for (const c of spec.containers ?? []) for (const p of c.ports ?? []) if (p.containerPort) set.add(p.containerPort)
  return Array.from(set).sort((a, b) => a - b)
}
function servicePorts(obj: K8sObject): number[] {
  const spec = (obj.spec ?? {}) as { ports?: Array<{ port?: number }> }
  const set = new Set<number>()
  for (const p of spec.ports ?? []) if (p.port) set.add(p.port)
  return Array.from(set).sort((a, b) => a - b)
}

const EMPTY_METRICS: MetricsMap = { available: false, byKey: new Map() }

export function DetailView({
  def,
  obj,
  now,
  theme,
  contextVersion,
  initialTab,
  readOnly = false,
  onBack,
  onSplit,
  onDrill,
  onChanged
}: Props): React.ReactElement {
  const isPod = def.kind === 'Pod'
  const isNode = def.kind === 'Node'
  const isService = def.kind === 'Service'
  const isWorkload = ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'replicasets', 'replicationcontrollers'].includes(
    def.key
  )
  const isDeployment = def.key === 'deployments'
  const isCronJob = def.key === 'cronjobs'
  const isJob = def.key === 'jobs'
  const isArgoApp = def.kind === 'Application' && def.custom?.group === 'argoproj.io'
  const meta = obj.metadata ?? {}
  const toast = useToast()

  const tabs: Tab[] = isPod
    ? ['status', 'describe', 'specifications', 'view', 'labels', 'related', 'logs', 'terminal', 'files', 'ports', 'events']
    : isNode
      ? ['status', 'describe', 'specifications', 'view', 'labels', 'images', 'events']
      : isService
        ? ['status', 'describe', 'specifications', 'view', 'labels', 'related', 'ports', 'events']
        : isWorkload
          ? ['status', 'describe', 'specifications', 'view', 'labels', 'related', 'logs', 'events']
          : ['status', 'describe', 'specifications', 'view', 'labels', 'events']

  const [tab, setTab] = useState<Tab>(initialTab && tabs.includes(initialTab) ? initialTab : 'status')
  // Tabs whose panels stay mounted after a visit, so switching away doesn't
  // kill a log stream or shell session. Reset when the object changes.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([tab]))
  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)))
  }, [tab])
  useEffect(() => {
    setVisited(new Set([tab]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.uid])

  const baseYaml = useMemo(() => toYaml(obj), [obj])
  const [editText, setEditText] = useState(baseYaml)
  const diffRows = useMemo(() => diffLines(baseYaml, editText), [baseYaml, editText])
  const stat = diffStat(diffRows)
  const dirty = stat.added > 0 || stat.removed > 0
  const [applyStatus, setApplyStatus] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(null)
  const [applying, setApplying] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{ def: ResourceDef; obj: K8sObject } | null>(null)
  const [showScale, setShowScale] = useState(false)
  const [showRestart, setShowRestart] = useState(false)
  const [confirmAction, setConfirmAction] = useState<{
    title: string
    body: React.ReactNode
    label: string
    danger?: boolean
    run: () => Promise<void>
  } | null>(null)
  const [showCtxDiff, setShowCtxDiff] = useState(false)
  const [otherContexts, setOtherContexts] = useState(0)
  const [currentCtx, setCurrentCtx] = useState<string | undefined>()
  useEffect(() => {
    // The Compare button only makes sense with a second context (desktop).
    api
      .listContexts()
      .then((all) => {
        setOtherContexts(Math.max(0, all.length - 1))
        setCurrentCtx(all.find((c) => c.current)?.name)
      })
      .catch(() => setOtherContexts(0))
  }, [contextVersion])

  // usage trend for the Status tab (pods & nodes) from the shared history buffer
  const [historyTick, setHistoryTick] = useState(0)
  useEffect(() => {
    if (!isPod && !isNode) return
    return onMetricsHistory(() => setHistoryTick((t) => t + 1))
  }, [isPod, isNode])
  const usageHistory = useMemo(() => {
    if (!isPod && !isNode) return []
    return historyFor(isPod ? 'pods' : 'nodes', obj.metadata?.namespace, obj.metadata?.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyTick, isPod, isNode, obj.metadata?.uid])

  const name = meta.name ?? ''
  const ns = meta.namespace
  const nodeUnschedulable = getByPath(obj, 'spec.unschedulable') === true
  const deployPaused = getByPath(obj, 'spec.paused') === true
  const cronSuspended = getByPath(obj, 'spec.suspend') === true

  // Run a mutation, toast the outcome, refresh the list.
  async function act(p: Promise<MutationResult>, okMsg: string, thenBack = false): Promise<void> {
    if (readOnly) {
      toast.error('Read-only mode is on - unlock it in Preferences.')
      return
    }
    const res = await p
    if (res.ok) {
      toast.success(okMsg)
      onChanged()
      if (thenBack) onBack()
    } else {
      toast.error(res.error ?? 'Action failed')
    }
  }

  useEffect(() => {
    setEditText(baseYaml)
    setApplyStatus(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.uid])

  // metrics for this object's own kind (Status tab bars) - pods & nodes only
  const [selfMetrics, setSelfMetrics] = useState<MetricsMap>(EMPTY_METRICS)
  useEffect(() => {
    const kind = isPod ? 'pods' : isNode ? 'nodes' : null
    if (!kind) {
      setSelfMetrics(EMPTY_METRICS)
      return
    }
    let disposed = false
    const load = (): void => {
      api.getMetrics(kind).then((r) => {
        if (disposed) return
        const byKey = new Map()
        for (const s of r.samples) byKey.set(metricKey(s.namespace, s.name), s)
        setSelfMetrics({ available: r.available, byKey })
      })
    }
    load()
    const t = setInterval(load, 8000)
    return () => {
      disposed = true
      clearInterval(t)
    }
  }, [isPod, isNode, meta.uid, contextVersion])

  // Pods this resource manages: nodes host pods (by nodeName); services and
  // workloads select pods (by label selector). Shown under the Status tab.
  const selector = useMemo(() => getSelector(obj), [obj])
  const needsPods = isNode || !!selector
  const podsDef = needsPods ? getResourceDef('pods') : undefined
  const podsData = useResourceData(podsDef, contextVersion)
  const managedPods = useMemo(() => {
    if (!needsPods) return []
    if (isNode) return podsData.items.filter((p) => (getByPath(p, 'spec.nodeName') as string) === meta.name)
    if (!selector) return []
    return podsData.items.filter((p) => p.metadata?.namespace === meta.namespace && matchesSelector(p, selector))
  }, [needsPods, isNode, selector, podsData.items, meta.name, meta.namespace])

  const containers = isPod ? podContainers(obj) : []

  function offerForce(err: string): void {
    setApplyStatus({ kind: 'error', msg: err })
    setConfirmAction({
      title: 'Field ownership conflict',
      danger: true,
      label: 'Force apply',
      body: (
        <>
          <p>Another manager owns some of the fields you are changing:</p>
          <pre className="conflict-pre">{err}</pre>
          <p>
            Forcing takes ownership of those fields. If they are managed by a GitOps controller
            (ArgoCD, Flux), it will likely revert your change on its next sync.
          </p>
        </>
      ),
      run: () => applyWith(true)
    })
  }

  async function applyWith(force: boolean): Promise<void> {
    if (readOnly) {
      toast.error('Read-only mode is on - unlock it in Preferences.')
      return
    }
    setApplying(true)
    setApplyStatus(null)
    // Server dry-run first: validation + field-manager conflicts surface
    // without persisting anything.
    const dry = await api.applyYaml(editText, { dryRun: true, force })
    if (!dry.ok) {
      setApplying(false)
      if (!force && /conflict/i.test(dry.error ?? '')) offerForce(dry.error ?? '')
      else {
        setApplyStatus({ kind: 'error', msg: dry.error ?? 'Apply failed' })
        toast.error(dry.error ?? 'Apply failed')
      }
      return
    }
    const res = await api.applyYaml(editText, { force })
    setApplying(false)
    if (res.ok) {
      setApplyStatus({
        kind: 'ok',
        msg: force ? 'Applied - took ownership of conflicting fields.' : 'Applied successfully.'
      })
      toast.success('Applied changes')
      onChanged()
    } else if (!force && /conflict/i.test(res.error ?? '')) {
      offerForce(res.error ?? '')
    } else {
      setApplyStatus({ kind: 'error', msg: res.error ?? 'Apply failed' })
      toast.error(res.error ?? 'Apply failed')
    }
  }

  const applyEdits = (): Promise<void> => applyWith(false)

  // Node shell / pod debug open a terminal in a modal against the created target.
  const [shellBusy, setShellBusy] = useState(false)
  const [debugBusy, setDebugBusy] = useState(false)
  const [termModal, setTermModal] = useState<{
    title: string
    namespace: string
    pod: string
    container: string
    command?: string[]
    /** delete this pod on close (node-shell helper pods) */
    cleanupPod?: boolean
  } | null>(null)

  function closeTermModal(): void {
    const m = termModal
    setTermModal(null)
    // Node-shell helper pods are ours - remove them so nothing privileged lingers.
    if (m?.cleanupPod) {
      api.deleteResource('pods', m.pod, m.namespace).then((r) => {
        if (!r.ok) toast.error(`Could not remove node-shell pod: ${r.error ?? ''}`)
      })
    }
  }

  async function openNodeShell(): Promise<void> {
    setShellBusy(true)
    const res = await api.nodeShell(name)
    setShellBusy(false)
    if (!res.ok || !res.pod) {
      toast.error(res.error ?? 'Could not start node shell')
      return
    }
    toast.success(`Node shell ready on ${name}`)
    setTermModal({
      title: `Node shell · ${name}`,
      namespace: res.pod.metadata?.namespace ?? 'kube-system',
      pod: res.pod.metadata?.name ?? '',
      container: 'shell',
      // enter the host namespaces for a real root shell; prefer bash, fall back to sh
      command: ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', 'exec bash -l 2>/dev/null || exec sh'],
      cleanupPod: true
    })
  }

  async function openDebug(): Promise<void> {
    setDebugBusy(true)
    const res = await api.debugPod(ns ?? 'default', name)
    setDebugBusy(false)
    if (!res.ok || !res.container) {
      toast.error(res.error ?? 'Could not attach debug container')
      return
    }
    toast.success(`Debug container ${res.container} attached`)
    setTermModal({
      title: `Debug · ${name}`,
      namespace: ns ?? 'default',
      pod: name,
      container: res.container
    })
  }
  async function doDelete(): Promise<void> {
    if (!confirmDelete) return
    const d = confirmDelete.def
    const m = confirmDelete.obj.metadata ?? {}
    const res = d.custom
      ? await api.deleteCustom(d.custom, m.name ?? '', m.namespace)
      : await api.deleteResource(d.key, m.name ?? '', m.namespace)
    setConfirmDelete(null)
    if (!res.ok) {
      toast.error(res.error ?? 'Delete failed')
      return
    }
    toast.success(`Deleted ${d.kind} ${m.name}`)
    onChanged()
    if (m.uid === meta.uid) onBack()
  }
  async function doScale(replicas: number): Promise<void> {
    setShowScale(false)
    await act(api.scaleResource(def.key, name, ns, replicas), `Scaled ${name} to ${replicas}`)
  }
  async function doRestart(): Promise<void> {
    setShowRestart(false)
    await act(api.restartResource(def.key, name, ns), `Rollout restart of ${name} started`)
  }

  const flush = tab === 'view' || tab === 'logs' || tab === 'terminal'

  return (
    <>
      <div className="detail-head">
        <button className="icon-btn" title="Back" onClick={onBack}>
          <Icon name="chevron-left" size={18} />
        </button>
        <span className="detail-head__icon">
          <Icon name={def.icon} size={20} />
        </span>
        <h1 className="detail-head__title">
          <span className="detail-crumb">{def.label}</span>
          <span className="detail-crumb__sep"> / </span>
          {meta.name}
        </h1>
        <div className={`detail-head__actions${readOnly ? ' is-readonly' : ''}`}>
          {isArgoApp && (
            <>
              <button className="btn btn--secondary" onClick={() => act(api.argoSync(ns ?? '', name), 'Sync triggered')}>
                <Icon name="refresh" size={13} /> Sync
              </button>
              <button className="btn btn--secondary" onClick={() => act(api.argoRefresh(ns ?? '', name), 'Refresh requested')}>
                <Icon name="refresh" size={13} /> Refresh
              </button>
            </>
          )}
          {isNode && (
            <>
              <button
                className="btn btn--secondary"
                onClick={() =>
                  act(
                    api.patchMerge('nodes', name, undefined, { spec: { unschedulable: !nodeUnschedulable } }),
                    nodeUnschedulable ? 'Node uncordoned' : 'Node cordoned'
                  )
                }
              >
                {nodeUnschedulable ? 'Uncordon' : 'Cordon'}
              </button>
              <button
                className="btn btn--secondary"
                onClick={() =>
                  setConfirmAction({
                    title: `Drain ${name}`,
                    body: <>Cordon <strong>{name}</strong> and evict its pods (DaemonSet pods are skipped)?</>,
                    label: 'Drain',
                    run: () => act(api.drainNode(name), `Draining ${name}`)
                  })
                }
              >
                Drain
              </button>
              <button
                className="btn btn--secondary"
                disabled={readOnly}
                title="Open a privileged root shell on this node (creates a temporary host pod)"
                onClick={openNodeShell}
              >
                <Icon name="terminal" size={13} /> {shellBusy ? 'Starting...' : 'Shell'}
              </button>
            </>
          )}
          {isPod && (
            <button
              className="btn btn--secondary"
              disabled={readOnly}
              title="Attach an ephemeral debug container (works on distroless pods)"
              onClick={openDebug}
            >
              <Icon name="terminal" size={13} /> {debugBusy ? 'Attaching...' : 'Debug'}
            </button>
          )}
          {isDeployment && (
            <>
              <button
                className="btn btn--secondary"
                onClick={() =>
                  act(
                    api.patchMerge('deployments', name, ns, { spec: { paused: !deployPaused } }),
                    deployPaused ? 'Rollout resumed' : 'Rollout paused'
                  )
                }
              >
                {deployPaused ? 'Resume' : 'Pause'}
              </button>
              <button
                className="btn btn--secondary"
                onClick={() =>
                  setConfirmAction({
                    title: `Roll back ${name}`,
                    body: <>Roll <strong>{name}</strong> back to its previous revision?</>,
                    label: 'Rollback',
                    run: () => act(api.rollbackDeployment(name, ns ?? ''), `Rolled back ${name}`)
                  })
                }
              >
                <Icon name="refresh" size={13} /> Rollback
              </button>
            </>
          )}
          {isCronJob && (
            <>
              <button className="btn btn--secondary" onClick={() => act(api.triggerCronJob(name, ns ?? ''), 'Job triggered')}>
                Trigger
              </button>
              <button
                className="btn btn--secondary"
                onClick={() =>
                  act(
                    api.patchMerge('cronjobs', name, ns, { spec: { suspend: !cronSuspended } }),
                    cronSuspended ? 'CronJob resumed' : 'CronJob suspended'
                  )
                }
              >
                {cronSuspended ? 'Resume' : 'Suspend'}
              </button>
            </>
          )}
          {isJob && (
            <button
              className="btn btn--secondary"
              onClick={() =>
                setConfirmAction({
                  title: `Re-run ${name}`,
                  body: <>Create a new Job from <strong>{name}</strong>'s spec?</>,
                  label: 'Re-run',
                  run: () => act(api.rerunJob(name, ns ?? ''), 'Re-run job created')
                })
              }
            >
              Re-run
            </button>
          )}
          {isPod && (
            <button
              className="btn btn--secondary"
              onClick={() =>
                setConfirmAction({
                  title: `Restart ${name}`,
                  body: <>Delete pod <strong>{name}</strong>? Its controller will recreate it.</>,
                  label: 'Restart',
                  danger: true,
                  run: () => act(api.deleteResource('pods', name, ns), `Restarting ${name}`, true)
                })
              }
            >
              <Icon name="refresh" size={13} /> Restart
            </button>
          )}
          {RESTARTABLE.has(def.key) && (
            <button className="btn btn--secondary" onClick={() => setShowRestart(true)}>
              <Icon name="refresh" size={13} /> Rollout
            </button>
          )}
          {SCALABLE.has(def.key) && (
            <button className="btn btn--secondary" onClick={() => setShowScale(true)}>
              <Icon name="scale" size={13} /> Scale
            </button>
          )}
          {otherContexts > 0 && def.api !== 'helm' && !def.custom && (
            <button
              className="btn btn--secondary"
              data-safe
              title="Diff this object against another kubeconfig context"
              onClick={() => setShowCtxDiff(true)}
            >
              <Icon name="git-branch" size={13} /> Compare
            </button>
          )}
          {onSplit && (
            <button
              className="btn btn--secondary"
              data-safe
              title="Pin this object beside the list so you can browse and compare"
              onClick={onSplit}
            >
              <Icon name="columns" size={13} /> Split
            </button>
          )}
          <button className="btn btn--secondary" data-safe onClick={() => setTab('view')}>
            <Icon name="pencil" size={13} /> Edit
          </button>
          <button
            className="btn btn--secondary"
            data-safe
            title="Save this object as a reusable Create template (status and server fields stripped; Secret values are replaced with placeholders)"
            onClick={() => {
              const tname = `${def.kind} - ${name}`
              saveUserTemplate({ name: tname, kind: def.kind, yaml: objectToTemplateYaml(obj) })
              toast.success(`Saved template "${tname}"`)
            }}
          >
            <Icon name="copy" size={13} /> Template
          </button>
          <button className="btn btn--danger" onClick={() => setConfirmDelete({ def, obj })}>
            <Icon name="trash" size={13} /> Delete
          </button>
        </div>
      </div>

      <div className="detail-tabs">
        {tabs.map((t) => {
          // A panel kept mounted in the background gets a dot (the session may
          // still be streaming, or may have ended - it is not torn down).
          const kept = (t === 'logs' || t === 'terminal') && visited.has(t) && tab !== t
          return (
            <button key={t} className={`detail-tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
              <Icon name={TAB_ICON[t]} size={14} />
              {TAB_LABEL[t]}
              {kept && <span className="tab-live-dot" title="Kept open in background" />}
            </button>
          )
        })}
      </div>

      <div className={`detail-body${flush ? ' detail-body--flush' : ''}`}>
        {tab === 'status' && (
          <div className="detail-status">
            <div className="detail-table">
              <ResourceTable
                def={def}
                items={[obj]}
                metrics={isPod || isNode ? selfMetrics : EMPTY_METRICS}
                now={now}
                onSelect={() => setTab('specifications')}
                onDelete={(o) => setConfirmDelete({ def, obj: o })}
              />
            </div>

            {usageHistory.length >= 2 && (
              <div className="trend-cards">
                <div className="trend-card">
                  <div className="trend-card__head">
                    <span className="trend-card__label">CPU · last {Math.round(((usageHistory[usageHistory.length - 1].t - usageHistory[0].t) / 60000) || 1)}m</span>
                    <span className="trend-card__value">{formatCpu(usageHistory[usageHistory.length - 1].cpu)}</span>
                  </div>
                  <Spark values={usageHistory.map((p) => p.cpu)} width={260} height={40} />
                </div>
                <div className="trend-card">
                  <div className="trend-card__head">
                    <span className="trend-card__label">Memory</span>
                    <span className="trend-card__value">{formatMemory(usageHistory[usageHistory.length - 1].memory)}</span>
                  </div>
                  <Spark values={usageHistory.map((p) => p.memory)} width={260} height={40} />
                </div>
              </div>
            )}

            {needsPods && (
              <div className="detail-related">
                <div className="detail-related__title">Pods{managedPods.length ? ` (${managedPods.length})` : ''}</div>
                {managedPods.length ? (
                  <div className="detail-table">
                    <ResourceTable
                      def={podsDef!}
                      items={managedPods}
                      metrics={podsData.metrics}
                      now={now}
                      onSelect={(p) => onDrill(podsDef!, p)}
                      onDelete={(p) => setConfirmDelete({ def: podsDef!, obj: p })}
                    />
                  </div>
                ) : (
                  <div className="empty-hint" style={{ textAlign: 'left' }}>
                    No pods managed by this {def.kind.toLowerCase()}.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'specifications' && <SpecificationsPanel def={def} obj={obj} now={now} />}
        {tab === 'describe' && <DescribePanel obj={obj} now={now} />}
        {tab === 'related' && <RelatedPanel def={def} obj={obj} onDrill={onDrill} />}
        {tab === 'labels' && <LabelsPanel obj={obj} />}
        {tab === 'images' && isNode && <ImagesPanel obj={obj} />}
        {tab === 'files' && isPod && (
          <FilesPanel namespace={meta.namespace ?? 'default'} pod={meta.name ?? ''} containers={containers} readOnly={readOnly} />
        )}

        {tab === 'view' && (
          <>
            <div className="panel-toolbar">
              <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
                Edit and apply with server-side apply
              </span>
              {dirty && (
                <span className="diff-stat">
                  <span className="diff-stat__add">+{stat.added}</span>
                  <span className="diff-stat__del">-{stat.removed}</span>
                </span>
              )}
              <div className="panel-toolbar__spacer" />
              <button
                className={`btn btn--secondary${showDiff ? ' is-active' : ''}`}
                onClick={() => setShowDiff((d) => !d)}
                disabled={!dirty}
                title={dirty ? 'Show changes vs live object' : 'No changes to diff'}
              >
                <Icon name="git-branch" size={13} /> Diff
              </button>
              <button className="btn btn--secondary" onClick={() => setEditText(baseYaml)} disabled={applying || !dirty}>
                Reset
              </button>
              <button className="btn btn--primary" onClick={applyEdits} disabled={applying || !dirty}>
                <Icon name="save" size={13} /> {applying ? 'Applying...' : 'Apply'}
              </button>
            </div>
            {showDiff && dirty ? (
              <div className="yaml-diff">
                {diffRows.map((r, idx) => (
                  <div key={idx} className={`yaml-diff__row yaml-diff__row--${r.kind}`}>
                    <span className="yaml-diff__gutter">{r.oldNo ?? ''}</span>
                    <span className="yaml-diff__gutter">{r.newNo ?? ''}</span>
                    <span className="yaml-diff__sign">
                      {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
                    </span>
                    <span className="yaml-diff__text">{r.text || ' '}</span>
                  </div>
                ))}
              </div>
            ) : (
              <YamlEditor value={editText} onChange={setEditText} theme={theme} />
            )}
            {applyStatus && (
              <div className={`editor-status ${applyStatus.kind === 'ok' ? 'is-ok' : 'is-error'}`}>{applyStatus.msg}</div>
            )}
          </>
        )}

        {tab === 'events' && (
          <EventsPanel name={meta.name ?? ''} namespace={meta.namespace} kind={def.kind} now={now} />
        )}
        {isPod && visited.has('logs') && (
          <div className={`panel-keep${tab === 'logs' ? '' : ' is-hidden'}`}>
            <LogsPanel namespace={meta.namespace ?? 'default'} pod={meta.name ?? ''} containers={containers} />
          </div>
        )}
        {isWorkload && visited.has('logs') && (
          <div className={`panel-keep${tab === 'logs' ? '' : ' is-hidden'}`}>
            <WorkloadLogsPanel namespace={meta.namespace ?? 'default'} pods={managedPods} />
          </div>
        )}
        {isPod && visited.has('terminal') && (
          <div className={`panel-keep${tab === 'terminal' ? '' : ' is-hidden'}`}>
            <TerminalPanel namespace={meta.namespace ?? 'default'} pod={meta.name ?? ''} containers={containers} />
          </div>
        )}
        {tab === 'ports' && isPod && (
          <ForwardPanel namespace={meta.namespace ?? 'default'} pod={meta.name ?? ''} ports={podPorts(obj)} />
        )}
        {tab === 'ports' && isService && (
          <ForwardPanel namespace={meta.namespace ?? 'default'} service={meta.name ?? ''} ports={servicePorts(obj)} />
        )}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title={`Delete ${confirmDelete.def.kind}`}
          danger
          confirmLabel="Delete"
          body={
            <>
              Delete <strong>{confirmDelete.obj.metadata?.name}</strong>
              {confirmDelete.obj.metadata?.namespace ? ` in ${confirmDelete.obj.metadata.namespace}` : ''}? This cannot
              be undone.
            </>
          }
          onConfirm={doDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {showScale && (
        <ScaleModal
          name={meta.name ?? ''}
          current={(getByPath(obj, 'spec.replicas') as number) ?? 1}
          onConfirm={doScale}
          onCancel={() => setShowScale(false)}
        />
      )}
      {showRestart && (
        <ConfirmModal
          title={`Rollout restart ${def.kind}`}
          confirmLabel="Restart"
          body={
            <>
              Trigger a rolling restart of <strong>{meta.name}</strong>? Pods will be recreated one batch at a time.
            </>
          }
          onConfirm={doRestart}
          onCancel={() => setShowRestart(false)}
        />
      )}
      {confirmAction && (
        <ConfirmModal
          title={confirmAction.title}
          confirmLabel={confirmAction.label}
          danger={confirmAction.danger}
          body={confirmAction.body}
          onConfirm={async () => {
            const run = confirmAction.run
            setConfirmAction(null)
            await run()
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {showCtxDiff && (
        <ContextDiffModal def={def} obj={obj} currentContext={currentCtx} onClose={() => setShowCtxDiff(false)} />
      )}

      {termModal && (
        <div className="modal-overlay" onClick={closeTermModal}>
          <div className="modal modal--lg term-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <Icon name="terminal" size={16} />
              <span className="modal__title">{termModal.title}</span>
              <button
                className="icon-btn"
                style={{ marginLeft: 'auto' }}
                onClick={closeTermModal}
                title="Close"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal__body modal__body--flush term-modal__body">
              <TerminalPanel
                namespace={termModal.namespace}
                pod={termModal.pod}
                containers={[termModal.container]}
                initialContainer={termModal.container}
                command={termModal.command}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
