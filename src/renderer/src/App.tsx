import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { getResourceDef, type ResourceDef } from '@shared/catalog'
import type { ClusterInfo, K8sObject, KubeContextInfo } from '@shared/types'
import { Sidebar, type FavItem } from './components/Sidebar'
import type { RowAction } from './components/ResourceTable'
import { toCsv } from './lib/csv'
import { TopBar, type MenuKind } from './components/TopBar'
import { ResourceTable } from './components/ResourceTable'
import { DetailView } from './components/DetailView'
import { HelmDetailView } from './components/HelmDetailView'
import { Overview } from './components/Overview'
import { FleetView } from './components/FleetView'
import { AccessView } from './components/AccessView'
import { AuditView } from './components/AuditView'
import { RightSizingView } from './components/RightSizingView'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { Icon } from './components/Icon'
import { CreateResourceModal } from './components/modals/CreateResourceModal'
import { PortForwardManager } from './components/modals/PortForwardManager'
import { ConfirmModal } from './components/modals/ConfirmModal'
import { PickModal } from './components/modals/PickModal'
import { RepositoriesModal } from './components/modals/RepositoriesModal'
import { PreferencesModal } from './components/modals/PreferencesModal'
import { AboutModal } from './components/modals/AboutModal'
import { ShortcutsModal } from './components/modals/ShortcutsModal'
import { useResourceData } from './hooks/useResourceData'
import { useCounts, displayCount } from './hooks/useCounts'
import { useCatalog } from './hooks/useCatalog'
import { usePortForwards } from './state/portForwards'
import { useToast } from './state/toast'
import { loadPrefs, savePrefs, type SavedView } from './lib/prefs'
import { startMetricsHistory, resetMetricsHistory } from './lib/metricsHistory'

/** Full-page views that are not resource lists (rendered without a def). */
const SPECIAL_VIEWS = new Set(['overview', 'fleet', 'access', 'audit', 'rightsizing'])

interface DetailEntry {
  def: ResourceDef
  obj: K8sObject
  /** open the detail on a specific tab (row quick actions) */
  tab?: string
}

function launchParams(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search)
  } catch {
    return new URLSearchParams()
  }
}
const PARAMS = launchParams()

function initialResourceKey(): string {
  const q = PARAMS.get('resource')
  if (q && (SPECIAL_VIEWS.has(q) || getResourceDef(q) || q.startsWith('crd:'))) return q
  return 'pods'
}

const PREFS = loadPrefs()

export function App(): React.ReactElement {
  const toast = useToast()
  const [activeKey, setActiveKey] = useState(initialResourceKey)
  const [back, setBack] = useState<string[]>([])
  const [forward, setForward] = useState<string[]>([])
  const [detailStack, setDetailStack] = useState<DetailEntry[]>([])

  const [namespace, setNamespace] = useState(PARAMS.get('ns') || PREFS.lastNamespace || 'All')
  const [search, setSearch] = useState('')
  const [labelFilter, setLabelFilter] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>(PREFS.theme)
  const [favorites, setFavorites] = useState<Set<string>>(new Set(PREFS.favorites))

  const [contexts, setContexts] = useState<KubeContextInfo[]>([])
  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | undefined>()
  const [contextVersion, setContextVersion] = useState(0)
  const [nsList, setNsList] = useState<string[]>([])
  const [now, setNow] = useState(() => Date.now())

  const [createOpen, setCreateOpen] = useState(PARAMS.get('create') === '1')
  const [createTemplate, setCreateTemplate] = useState<string | undefined>()
  const [pfOpen, setPfOpen] = useState(false)
  const [menu, setMenu] = useState<MenuKind | null>(null)
  const [pendingDelete, setPendingDelete] = useState<K8sObject | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [density, setDensity] = useState(PREFS.density)
  const [readOnly, setReadOnly] = useState(false)
  const [hiddenCols, setHiddenCols] = useState<Record<string, string[]>>(PREFS.hiddenColumns)
  const [colsOpen, setColsOpen] = useState(false)
  // Multi-select for bulk actions: uid -> object (objects kept for name/ns at run time)
  const [selection, setSelection] = useState<Map<string, K8sObject>>(new Map())
  const [bulkConfirm, setBulkConfirm] = useState<'delete' | 'restart' | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [restartConfirm, setRestartConfirm] = useState<K8sObject | null>(null)
  const [savedViews, setSavedViews] = useState<Record<string, SavedView[]>>(PREFS.savedViews)
  const [viewsOpen, setViewsOpen] = useState(false)
  const [savingView, setSavingView] = useState(false)
  const [viewName, setViewName] = useState('')

  useEffect(() => {
    api.getReadOnly().then(setReadOnly)
    // shared usage-history buffer behind sparklines (Overview tiles, Status tab)
    startMetricsHistory()
  }, [])
  useEffect(() => savePrefs({ savedViews }), [savedViews])

  // Keyboard: `/` focuses the list search, Esc backs out of detail views.
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, .cm-editor') || target.isContentEditable)) {
        if (e.key === 'Escape') target.blur()
        return
      }
      if (document.querySelector('.modal-overlay')) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape' && detailStack.length) {
        goBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailStack.length])

  // Connectivity: light poll; two consecutive failures show the banner.
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    let fails = 0
    let disposed = false
    const probe = async (): Promise<void> => {
      try {
        await api.ping()
        if (!disposed) {
          fails = 0
          setOffline(false)
        }
      } catch {
        fails++
        if (!disposed && fails >= 2) setOffline(true)
      }
    }
    const t = setInterval(probe, 15000)
    return () => {
      disposed = true
      clearInterval(t)
    }
  }, [contextVersion])

  // kubeconfig changed on disk (rotated creds, new contexts) - refresh state.
  useEffect(() => {
    const unsub = api.onKubeconfigChanged((info) => {
      loadContexts()
      if (!info.currentContextStillExists) {
        toast.error('kubeconfig reloaded - the current context no longer exists')
      } else {
        toast.info('kubeconfig reloaded from disk')
        refresh()
      }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function exportCsv(): void {
    if (!def) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([toCsv(def, filtered, effectiveHidden)], { type: 'text/csv' }))
    a.download = `${def.key}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success(`Exported ${filtered.length} rows`)
  }

  // Native application-menu selections (desktop only). The menu deliberately
  // owns no UI of its own - it routes here so there is one implementation of
  // each screen, shared with the in-cluster web build that has no native menu.
  useEffect(() => {
    const unsub = api.onMenuAction((action) => {
      if (action.startsWith('menu:')) {
        setMenu(action.slice(5) as MenuKind)
        return
      }
      if (action.startsWith('view:')) {
        navigate(action.slice(5))
        return
      }
      switch (action) {
        case 'about':
        case 'shortcuts':
        case 'preferences':
          setMenu(action as MenuKind)
          break
        case 'create':
          openCreate()
          break
        case 'export-csv':
          exportCsv()
          break
        case 'palette':
          setPaletteOpen(true)
          break
        case 'search':
          searchRef.current?.focus()
          break
        case 'toggle-theme':
          setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
          break
        case 'toggle-density':
          setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))
          break
        case 'refresh':
          refresh()
          break
      }
    })
    return unsub
    // Re-subscribed on view change so the handlers close over current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  // Surface stray async failures as a toast instead of dying silently.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent): void => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason)
      toast.error(`Unexpected error: ${msg.slice(0, 200)}`)
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function toggleReadOnly(): Promise<void> {
    setReadOnly(await api.setReadOnly(!readOnly))
  }
  useEffect(() => savePrefs({ hiddenColumns: hiddenCols }), [hiddenCols])

  const catalog = useCatalog(contextVersion)
  const def = catalog.byKey.get(activeKey)
  const { items, loading, error, metrics, refresh } = useResourceData(def, contextVersion)
  const rawCounts = useCounts(contextVersion)
  const { forwards } = usePortForwards()

  // counts adjust to the selected namespace (namespaced resources only)
  const counts = useMemo(() => {
    const out: Record<string, number | undefined> = {}
    for (const key of Object.keys(rawCounts)) out[key] = displayCount(rawCounts[key], namespace)
    return out
  }, [rawCounts, namespace])

  const detail = detailStack[detailStack.length - 1] ?? null

  // Live-object search for the palette: on open, snapshot a few core kinds so
  // typing a name from an alert jumps straight to the object.
  const paletteObjRef = useRef<Map<string, K8sObject>>(new Map())
  const [paletteObjItems, setPaletteObjItems] = useState<PaletteItem[]>([])
  useEffect(() => {
    if (!paletteOpen) return
    let disposed = false
    const kinds = ['pods', 'deployments', 'services', 'configmaps', 'secrets', 'ingresses']
    const PER_KIND = 400 // keep the snapshot bounded on large clusters
    // Build into a local map and swap it in atomically so a pick between open
    // and load never reads a half-cleared ref.
    const nextMap = new Map<string, K8sObject>()
    Promise.all(
      kinds.map(async (k) => {
        const d = catalog.byKey.get(k)
        if (!d) return [] as PaletteItem[]
        try {
          const res = await api.listResource(k)
          return res.items.slice(0, PER_KIND).map((o) => {
            const key = `obj:${k}:${o.metadata?.namespace ?? ''}/${o.metadata?.name}`
            nextMap.set(key, o)
            return {
              key,
              label: o.metadata?.name ?? '',
              group: `${d.kind} · ${o.metadata?.namespace ?? 'cluster'}`,
              icon: d.icon
            }
          })
        } catch {
          return [] as PaletteItem[]
        }
      })
    ).then((all) => {
      if (disposed) return
      paletteObjRef.current = nextMap
      setPaletteObjItems(all.flat())
    })
    return () => {
      disposed = true
    }
  }, [paletteOpen, catalog])

  function onPalettePick(key: string): void {
    if (key.startsWith('obj:')) {
      const obj = paletteObjRef.current.get(key)
      const defKey = key.split(':')[1]
      const d = catalog.byKey.get(defKey)
      // Open the detail directly (it renders above any list); navigating first
      // would wipe the pushed detail via the activeKey-change effect.
      if (obj && d) setDetailStack([{ def: d, obj }])
      return
    }
    navigate(key)
  }

  // Effective hidden columns for the current resource: the user's override if
  // one exists, otherwise the catalog's defaultHidden set (kubectl -o wide).
  const effectiveHidden = useMemo(() => {
    if (!def) return new Set<string>()
    const override = hiddenCols[def.key]
    if (override) return new Set(override)
    return new Set(def.columns.filter((c) => c.defaultHidden).map((c) => c.id))
  }, [def, hiddenCols])

  function toggleColumn(id: string): void {
    if (!def) return
    const next = new Set(effectiveHidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setHiddenCols((prev) => ({ ...prev, [def.key]: [...next] }))
  }

  // selection is per resource+cluster+namespace view - clear when any changes
  useEffect(() => setSelection(new Map()), [activeKey, contextVersion, namespace])
  const selectionUids = useMemo(() => new Set(selection.keys()), [selection])

  function checkMany(objs: K8sObject[], isChecked: boolean): void {
    setSelection((prev) => {
      const next = new Map(prev)
      for (const o of objs) {
        const uid = o.metadata?.uid ?? `${o.metadata?.namespace}/${o.metadata?.name}`
        if (isChecked) next.set(uid, o)
        else next.delete(uid)
      }
      return next
    })
  }

  // Restart semantics per kind: rollout-restart for template workloads,
  // delete-and-recreate for bare pods.
  const bulkRestartable =
    !!def && (['deployments', 'statefulsets', 'daemonsets'].includes(def.key) || def.key === 'pods')

  async function runBulk(kind: 'delete' | 'restart'): Promise<void> {
    if (!def) return
    setBulkConfirm(null)
    setBulkBusy(true)
    const objs = [...selection.values()]
    let ok = 0
    const errs: string[] = []
    for (const o of objs) {
      const name = o.metadata?.name ?? ''
      const ns = o.metadata?.namespace
      const res =
        kind === 'delete'
          ? def.custom
            ? await api.deleteCustom(def.custom, name, ns)
            : await api.deleteResource(def.key, name, ns)
          : def.key === 'pods'
            ? await api.deleteResource('pods', name, ns)
            : await api.restartResource(def.key, name, ns)
      if (res.ok) ok++
      else errs.push(`${name}: ${res.error ?? 'failed'}`)
    }
    setBulkBusy(false)
    setSelection(new Map())
    refresh()
    const verb = kind === 'delete' ? 'Deleted' : 'Restarted'
    if (!errs.length) toast.success(`${verb} ${ok} ${ok === 1 ? 'item' : 'items'}`)
    else toast.error(`${verb} ${ok}, ${errs.length} failed - ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ''}`)
  }

  function handleRowAction(action: RowAction, obj: K8sObject): void {
    if (!def) return
    const name = obj.metadata?.name ?? ''
    const ns = obj.metadata?.namespace
    switch (action) {
      case 'edit':
        openDetail(def, obj, 'view')
        break
      case 'logs':
      case 'terminal':
      case 'ports':
        openDetail(def, obj, action)
        break
      case 'copy':
        navigator.clipboard
          .writeText(name)
          .then(() => toast.info(`Copied "${name}"`))
          .catch(() => toast.error('Clipboard unavailable'))
        break
      case 'restart':
        setRestartConfirm(obj)
        break
      case 'trigger':
        api.triggerCronJob(name, ns ?? '').then((r) => {
          if (r.ok) {
            toast.success(`Triggered ${name}`)
            refresh()
          } else toast.error(r.error ?? 'Trigger failed')
        })
        break
      case 'rerun':
        api.rerunJob(name, ns ?? '').then((r) => {
          if (r.ok) {
            toast.success(`Re-run created from ${name}`)
            refresh()
          } else toast.error(r.error ?? 'Re-run failed')
        })
        break
    }
  }

  async function doRowRestart(): Promise<void> {
    if (!restartConfirm || !def) return
    const name = restartConfirm.metadata?.name ?? ''
    const ns = restartConfirm.metadata?.namespace
    setRestartConfirm(null)
    const res =
      def.key === 'pods' ? await api.deleteResource('pods', name, ns) : await api.restartResource(def.key, name, ns)
    if (res.ok) {
      toast.success(`Restarting ${name}`)
      refresh()
    } else toast.error(res.error ?? 'Restart failed')
  }

  // close the choosers when navigating elsewhere or clicking outside them
  useEffect(() => {
    setColsOpen(false)
    setViewsOpen(false)
    setSavingView(false)
  }, [activeKey])
  const colsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!colsOpen) return
    const onDown = (e: MouseEvent): void => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [colsOpen])
  const viewsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!viewsOpen) return
    const onDown = (e: MouseEvent): void => {
      if (viewsRef.current && !viewsRef.current.contains(e.target as Node)) setViewsOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [viewsOpen])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    savePrefs({ theme })
  }, [theme])
  useEffect(() => savePrefs({ favorites: [...favorites] }), [favorites])
  useEffect(() => savePrefs({ lastNamespace: namespace }), [namespace])
  useEffect(() => savePrefs({ density }), [density])

  // Cmd/Ctrl-K opens the command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [
      { key: 'overview', label: 'Overview', group: '', icon: 'cube' },
      { key: 'fleet', label: 'Fleet', group: '', icon: 'layers' },
      { key: 'rightsizing', label: 'Right-sizing', group: '', icon: 'scale' },
      { key: 'access', label: 'Access (can I?)', group: '', icon: 'lock' },
      { key: 'audit', label: 'Audit log', group: '', icon: 'list' }
    ]
    for (const d of catalog.byKey.values()) out.push({ key: d.key, label: d.label, group: d.category, icon: d.icon })
    // live objects after resource kinds - typing a pod name finds it directly
    out.push(...paletteObjItems)
    return out
  }, [catalog, paletteObjItems])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])

  const loadNamespaces = useCallback(() => {
    api.getNamespaces().then(setNsList)
  }, [])
  const loadContexts = useCallback(() => {
    api.listContexts().then(setContexts)
  }, [])
  useEffect(() => {
    // Guard against out-of-order resolution: a slow response for the PREVIOUS
    // context must not overwrite the current one (visible as a wrong footer
    // after a quick context switch).
    let stale = false
    api.listContexts().then((c) => !stale && setContexts(c))
    api.getClusterInfo().then((ci) => !stale && setClusterInfo(ci))
    api.getNamespaces().then((ns) => !stale && setNsList(ns))
    return () => {
      stale = true
    }
  }, [contextVersion])

  // clear drill-down when switching the sidebar resource
  useEffect(() => setDetailStack([]), [activeKey])

  useEffect(() => {
    const ctx = PARAMS.get('context')
    if (ctx) api.setContext(ctx).then(() => setContextVersion((v) => v + 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const autoOpenedRef = useRef(false)

  const namespaces = useMemo(() => {
    const set = new Set<string>(nsList)
    for (const o of items) if (o.metadata?.namespace) set.add(o.metadata.namespace)
    if (namespace !== 'All') set.add(namespace)
    return Array.from(set).sort()
  }, [nsList, items, namespace])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const labels = labelFilter
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return items.filter((o) => {
      if (namespace !== 'All' && def?.namespaced && o.metadata?.namespace !== namespace) return false
      if (q) {
        const hay = `${o.metadata?.name ?? ''} ${o.metadata?.namespace ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (labels.length) {
        const objLabels = o.metadata?.labels ?? {}
        const ok = labels.every((f) => {
          const [k, v] = f.split('=')
          if (v === undefined) return k in objLabels
          return objLabels[k] === v
        })
        if (!ok) return false
      }
      return true
    })
  }, [items, search, labelFilter, namespace, def])

  useEffect(() => {
    if (PARAMS.get('open') === '1' && !autoOpenedRef.current && filtered.length && def) {
      autoOpenedRef.current = true
      setDetailStack([{ def, obj: filtered[0] }])
    }
  }, [filtered, def])

  function navigate(key: string): void {
    if (key === activeKey) {
      // Re-clicking the active resource resets any drill-down back to the list.
      setDetailStack([])
      return
    }
    setBack((b) => [...b, activeKey])
    setForward([])
    setActiveKey(key)
  }
  function goBack(): void {
    if (detailStack.length) {
      setDetailStack((s) => s.slice(0, -1))
      return
    }
    setBack((b) => {
      if (!b.length) return b
      const prev = b[b.length - 1]
      setForward((f) => [activeKey, ...f])
      setActiveKey(prev)
      return b.slice(0, -1)
    })
  }
  function goForward(): void {
    setForward((f) => {
      if (!f.length) return f
      const next = f[0]
      setBack((b) => [...b, activeKey])
      setActiveKey(next)
      return f.slice(1)
    })
  }

  const openDetail = (d: ResourceDef, o: K8sObject, tab?: string): void =>
    setDetailStack((s) => [...s, { def: d, obj: o, tab }])

  async function onContextChange(name: string): Promise<void> {
    const res = await api.setContext(name)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to switch context')
      return
    }
    toast.success(`Switched to ${name}`)
    setNamespace('All')
    setDetailStack([])
    resetMetricsHistory() // another cluster's usage history would be a lie
    setContextVersion((v) => v + 1)
  }

  // ---- saved views: filters + columns, recallable per resource ----
  function applySavedView(v: SavedView): void {
    setSearch(v.search)
    setLabelFilter(v.labelFilter)
    setNamespace(v.namespace)
    if (def) {
      setHiddenCols((prev) => {
        const next = { ...prev }
        if (v.hiddenColumns) next[def.key] = v.hiddenColumns
        else delete next[def.key]
        return next
      })
    }
    setViewsOpen(false)
    toast.info(`View "${v.name}" applied`)
  }

  function saveCurrentView(): void {
    if (!def || !viewName.trim()) return
    const view: SavedView = {
      name: viewName.trim(),
      search,
      labelFilter,
      namespace,
      hiddenColumns: hiddenCols[def.key]
    }
    setSavedViews((prev) => {
      const list = (prev[def.key] ?? []).filter((v) => v.name !== view.name)
      return { ...prev, [def.key]: [...list, view] }
    })
    setSavingView(false)
    setViewName('')
    toast.success(`Saved view "${view.name}"`)
  }

  function deleteSavedView(name: string): void {
    if (!def) return
    setSavedViews((prev) => ({ ...prev, [def.key]: (prev[def.key] ?? []).filter((v) => v.name !== name) }))
  }

  function openCreate(template?: string): void {
    setCreateTemplate(template)
    setCreateOpen(true)
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || !def) return
    const name = pendingDelete.metadata?.name ?? ''
    const ns = pendingDelete.metadata?.namespace
    const res = def.custom
      ? await api.deleteCustom(def.custom, name, ns)
      : await api.deleteResource(def.key, name, ns)
    setPendingDelete(null)
    if (!res.ok) toast.error(res.error ?? 'Delete failed')
    else {
      toast.success(`Deleted ${name}`)
      refresh()
    }
  }

  function toggleFavorite(): void {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(activeKey)) next.delete(activeKey)
      else next.add(activeKey)
      return next
    })
  }

  function removeFavorite(key: string): void {
    setFavorites((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  // Resolve favorited keys to sidebar items (built-in resources + CRDs + overview).
  const favItems = useMemo<FavItem[]>(() => {
    const special: Record<string, FavItem> = {
      overview: { key: 'overview', label: 'Overview', icon: 'chart' },
      fleet: { key: 'fleet', label: 'Fleet', icon: 'layers' },
      rightsizing: { key: 'rightsizing', label: 'Right-sizing', icon: 'scale' },
      access: { key: 'access', label: 'Access', icon: 'lock' },
      audit: { key: 'audit', label: 'Audit', icon: 'list' }
    }
    const out: FavItem[] = []
    for (const key of favorites) {
      if (special[key]) {
        out.push(special[key])
        continue
      }
      const d = catalog.byKey.get(key)
      if (d) out.push({ key: d.key, label: d.label, icon: d.icon })
    }
    return out
  }, [favorites, catalog])

  const isFav = favorites.has(activeKey)
  const title = def?.label ?? 'Panope'

  return (
    <div className="app-shell" data-density={density}>
      <Sidebar
        groups={catalog.groups}
        crdSections={catalog.crdSections}
        favorites={favItems}
        activeKey={activeKey}
        counts={counts}
        onSelect={navigate}
        onUnfavorite={removeFavorite}
      />

      <div className="main-column">
        <TopBar
          clusterInfo={clusterInfo}
          contexts={contexts}
          namespace={namespace}
          namespaces={namespaces}
          theme={theme}
          canBack={detailStack.length > 0 || back.length > 0}
          canForward={forward.length > 0}
          labelFilter={labelFilter}
          pfCount={forwards.length}
          onBack={goBack}
          onForward={goForward}
          onContextChange={onContextChange}
          onNamespaceChange={setNamespace}
          onLabelFilter={setLabelFilter}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onNewNamespace={() => openCreate('Namespace')}
          onOpenPortForwards={() => setPfOpen(true)}
          onMenu={(kind) => {
            if (kind === 'portforwards') setPfOpen(true)
            else if (kind === 'namespaces') navigate('namespaces')
            else setMenu(kind)
          }}
        />

        {activeKey === 'fleet' && !detail ? (
          <FleetView
            currentContext={clusterInfo?.context}
            onSwitchContext={(name) => {
              onContextChange(name)
              navigate('overview')
            }}
          />
        ) : activeKey === 'access' && !detail ? (
          <>
            <div className="page-header">
              <span className="page-header__icon">
                <Icon name="lock" size={20} />
              </span>
              <h1 className="page-header__title">Access</h1>
              <div style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 'var(--font-size-md)' }}>
                What the authorizer actually allows
              </div>
            </div>
            <AccessView namespaces={namespaces} namespace={namespace === 'All' ? 'All' : namespace} />
          </>
        ) : activeKey === 'audit' && !detail ? (
          <>
            <div className="page-header">
              <span className="page-header__icon">
                <Icon name="list" size={20} />
              </span>
              <h1 className="page-header__title">Audit</h1>
              <div style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 'var(--font-size-md)' }}>
                Actions performed through Panope
              </div>
            </div>
            <AuditView now={now} />
          </>
        ) : activeKey === 'rightsizing' && !detail ? (
          <>
            <div className="page-header">
              <span className="page-header__icon">
                <Icon name="scale" size={20} />
              </span>
              <h1 className="page-header__title">Right-sizing</h1>
              <div style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 'var(--font-size-md)' }}>
                Usage vs requests · {namespace === 'All' ? 'all namespaces' : namespace}
              </div>
            </div>
            <RightSizingView namespace={namespace} contextVersion={contextVersion} />
          </>
        ) : activeKey === 'overview' && !detail ? (
          <>
            <div className="page-header">
              <span className="page-header__icon">
                <Icon name="cube" size={20} />
              </span>
              <h1 className="page-header__title">Overview</h1>
              <div style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 'var(--font-size-md)' }}>
                {clusterInfo?.context}
                {clusterInfo?.version ? ` · Kubernetes ${clusterInfo.version}` : ''}
              </div>
            </div>
            <Overview
              counts={counts}
              clusterInfo={clusterInfo}
              contextVersion={contextVersion}
              now={now}
              catalog={catalog}
              onSelect={navigate}
              onOpen={openDetail}
            />
          </>
        ) : detail && detail.def.api === 'helm' ? (
          <HelmDetailView
            key={detail.obj.metadata?.uid ?? detail.obj.metadata?.name}
            def={detail.def}
            obj={detail.obj}
            theme={theme}
            readOnly={readOnly}
            onBack={goBack}
            onChanged={refresh}
          />
        ) : detail ? (
          <DetailView
            key={detail.obj.metadata?.uid ?? detail.obj.metadata?.name}
            def={detail.def}
            obj={detail.obj}
            now={now}
            theme={theme}
            contextVersion={contextVersion}
            initialTab={
              (detail.tab as never) ??
              (detailStack.length === 1 ? ((PARAMS.get('tab') as never) || undefined) : undefined)
            }
            readOnly={readOnly}
            onBack={goBack}
            onDrill={openDetail}
            onChanged={refresh}
          />
        ) : (
          <>
            <div className="page-header">
              <span className="page-header__icon">
                <Icon name={def?.icon ?? 'box'} size={20} />
              </span>
              <h1 className="page-header__title">{title}</h1>
              <button
                className={`page-header__star${isFav ? ' is-active' : ''}`}
                title="Favorite"
                onClick={toggleFavorite}
              >
                <Icon name="star" size={16} filled={isFav} />
              </button>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
                {readOnly && (
                  <span className="readonly-chip" title="Read-only mode is on - mutations, exec and port-forwards are blocked">
                    <Icon name="lock" size={12} /> Read-only
                  </span>
                )}
                <button className="btn btn--primary" onClick={() => openCreate()} disabled={readOnly}>
                  <Icon name="plus" size={13} /> Create
                </button>
              </div>
            </div>

            <div className="toolbar">
              <div className="input-wrap input-wrap--icon">
                <span className="input-wrap__icon">
                  <Icon name="search" size={14} />
                </span>
                <input
                  ref={searchRef}
                  className="input"
                  placeholder="Search...  ( / )"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {def && !def.hideName && (
                <div className="col-chooser" ref={colsRef}>
                  <button
                    className={`btn btn--secondary${colsOpen ? ' is-active' : ''}`}
                    title="Choose visible columns"
                    onClick={() => setColsOpen((o) => !o)}
                  >
                    <Icon name="columns" size={13} /> Columns
                  </button>
                  {colsOpen && (
                    <div className="col-chooser__menu">
                      {def.namespaced && (
                        <label className="col-chooser__item">
                          <input
                            type="checkbox"
                            checked={!effectiveHidden.has('namespace')}
                            onChange={() => toggleColumn('namespace')}
                          />
                          Namespace
                        </label>
                      )}
                      {def.columns.map((c) => (
                        <label key={c.id} className="col-chooser__item">
                          <input
                            type="checkbox"
                            checked={!effectiveHidden.has(c.id)}
                            onChange={() => toggleColumn(c.id)}
                          />
                          {c.header}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {def && !def.hideName && (
                <div className="col-chooser" ref={viewsRef}>
                  <button
                    className={`btn btn--secondary${viewsOpen ? ' is-active' : ''}`}
                    title="Saved views: recall a filter + column combination"
                    onClick={() => setViewsOpen((o) => !o)}
                  >
                    <Icon name="eye" size={13} /> Views
                    {(savedViews[def.key]?.length ?? 0) > 0 && (
                      <span className="views-count">{savedViews[def.key]!.length}</span>
                    )}
                  </button>
                  {viewsOpen && (
                    <div className="col-chooser__menu views-menu">
                      {(savedViews[def.key] ?? []).map((v) => (
                        <div key={v.name} className="views-item">
                          <button className="views-item__apply" onClick={() => applySavedView(v)} title={`ns=${v.namespace}${v.search ? ` search=${v.search}` : ''}${v.labelFilter ? ` labels=${v.labelFilter}` : ''}`}>
                            {v.name}
                          </button>
                          <button className="views-item__del" title="Delete view" onClick={() => deleteSavedView(v.name)}>
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                      {(savedViews[def.key]?.length ?? 0) === 0 && !savingView && (
                        <div className="views-empty">No saved views for {def.label.toLowerCase()} yet.</div>
                      )}
                      {savingView ? (
                        <div className="views-save">
                          <input
                            className="input"
                            autoFocus
                            placeholder="View name..."
                            value={viewName}
                            onChange={(e) => setViewName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveCurrentView()
                              if (e.key === 'Escape') setSavingView(false)
                            }}
                          />
                          <button className="btn btn--primary btn--xs" onClick={saveCurrentView} disabled={!viewName.trim()}>
                            Save
                          </button>
                        </div>
                      ) : (
                        <button className="views-add" onClick={() => setSavingView(true)}>
                          <Icon name="plus" size={12} /> Save current filters as view
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              <button
                className="btn btn--secondary"
                title="Toggle row density"
                onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
              >
                <Icon name="sliders" size={13} />
                {density === 'compact' ? 'Compact' : 'Comfortable'}
              </button>
              {def && !def.unsupported && (
                <button
                  className="btn btn--secondary"
                  title="Export the filtered rows to CSV"
                  onClick={exportCsv}
                  disabled={filtered.length === 0}
                >
                  <Icon name="save" size={13} /> CSV
                </button>
              )}
            </div>

            {error && <div className="error-banner">{error}</div>}

            {offline && (
              <div className="error-banner">
                Cluster unreachable - retrying every 15s. Check VPN / credentials / the API server.
              </div>
            )}

            {def && selection.size > 0 && (
              <div className="bulk-bar">
                <span className="bulk-bar__count">
                  {selection.size} selected
                </span>
                {bulkRestartable && (
                  <button
                    className="btn btn--secondary"
                    disabled={readOnly || bulkBusy}
                    title={def.key === 'pods' ? 'Delete pods - controllers recreate them' : 'Rollout restart'}
                    onClick={() => setBulkConfirm('restart')}
                  >
                    <Icon name="refresh" size={13} /> Restart
                  </button>
                )}
                <button
                  className="btn btn--danger"
                  disabled={readOnly || bulkBusy}
                  onClick={() => setBulkConfirm('delete')}
                >
                  <Icon name="trash" size={13} /> {bulkBusy ? 'Working...' : 'Delete'}
                </button>
                <button className="btn btn--secondary" disabled={bulkBusy} onClick={() => setSelection(new Map())}>
                  Clear
                </button>
              </div>
            )}

            <div className="table-region">
              {!def ? (
                catalog.crdsLoaded ? (
                  <div className="state">
                    <Icon name="box" size={28} />
                    <div className="state__title">Resource not available</div>
                    <div className="state__hint">This resource type isn't present on the current cluster.</div>
                  </div>
                ) : (
                  <div className="state">
                    <div className="spinner" />
                    <div className="state__title">Loading...</div>
                  </div>
                )
              ) : loading && items.length === 0 ? (
                <div className="state">
                  <div className="spinner" />
                  <div className="state__title">Loading {def.label.toLowerCase()}...</div>
                </div>
              ) : def.unsupported ? (
                <div className="state">
                  <Icon name={def.icon} size={28} />
                  <div className="state__title">{def.label}</div>
                  <div className="state__hint">
                    Helm integration is not part of this build yet.
                  </div>
                </div>
              ) : filtered.length === 0 ? (
                <div className="state">
                  <Icon name={def.icon} size={28} />
                  <div className="state__title">No {def.label.toLowerCase()} found</div>
                  <div className="state__hint">
                    {search || labelFilter || namespace !== 'All'
                      ? 'No resources match the current filters.'
                      : `There are no ${def.label.toLowerCase()} in this cluster.`}
                  </div>
                </div>
              ) : (
                <ResourceTable
                  def={def}
                  items={filtered}
                  metrics={metrics}
                  now={now}
                  hiddenColumns={effectiveHidden}
                  checked={def.api === 'helm' ? undefined : selectionUids}
                  onCheckMany={def.api === 'helm' ? undefined : checkMany}
                  readOnly={readOnly}
                  keyboardNav
                  onRowAction={handleRowAction}
                  onSelect={(o) => openDetail(def, o)}
                  onDelete={setPendingDelete}
                />
              )}
            </div>
          </>
        )}

        <footer className="footer">
          {activeKey === 'overview' ? (
            <span>Cluster overview</span>
          ) : detail ? (
            <span>{detail.def.kind} · {detail.obj.metadata?.name}</span>
          ) : (
            <span>
              {filtered.length} Result{filtered.length === 1 ? '' : 's'}
            </span>
          )}
          <div className="footer__spacer" />
          {clusterInfo?.context && <span>{clusterInfo.context}</span>}
          {clusterInfo?.version && <span>· Kubernetes {clusterInfo.version}</span>}
          <span title={metrics.available ? 'metrics-server connected' : 'metrics unavailable'}>
            <span className={`footer__dot${metrics.available ? '' : ' is-off'}`} style={{ display: 'inline-block' }} />
          </span>
        </footer>
      </div>

      {createOpen && (
        <CreateResourceModal
          theme={theme}
          contextKind={def?.kind}
          initialTemplate={createTemplate}
          onClose={() => setCreateOpen(false)}
          onApplied={() => {
            refresh()
            loadNamespaces()
          }}
        />
      )}

      {pfOpen && <PortForwardManager onClose={() => setPfOpen(false)} />}

      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          onSelect={onPalettePick}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {menu === 'contexts' && (
        <PickModal
          title="Contexts"
          icon="layers"
          current={clusterInfo?.context ?? ''}
          items={contexts.map((c) => ({ value: c.name, label: c.name, sub: c.cluster }))}
          onPick={onContextChange}
          onClose={() => setMenu(null)}
        />
      )}
      {menu === 'repositories' && <RepositoriesModal onClose={() => setMenu(null)} />}
      {menu === 'shortcuts' && <ShortcutsModal onClose={() => setMenu(null)} />}
      {menu === 'about' && (
        <AboutModal
          clusterInfo={clusterInfo}
          readOnly={readOnly}
          onClose={() => setMenu(null)}
        />
      )}
      {menu === 'preferences' && (
        <PreferencesModal
          theme={theme}
          readOnly={readOnly}
          onSetTheme={setTheme}
          onToggleReadOnly={toggleReadOnly}
          onClose={() => setMenu(null)}
        />
      )}

      {restartConfirm && def && (
        <ConfirmModal
          title={`Restart ${restartConfirm.metadata?.name}`}
          confirmLabel="Restart"
          body={
            def.key === 'pods' ? (
              <>
                Delete pod <strong>{restartConfirm.metadata?.name}</strong>? Its controller will recreate it.
              </>
            ) : (
              <>
                Rollout-restart <strong>{restartConfirm.metadata?.name}</strong>?
              </>
            )
          }
          onConfirm={doRowRestart}
          onCancel={() => setRestartConfirm(null)}
        />
      )}

      {bulkConfirm && def && (
        <ConfirmModal
          title={`${bulkConfirm === 'delete' ? 'Delete' : 'Restart'} ${selection.size} ${def.label.toLowerCase()}`}
          danger={bulkConfirm === 'delete'}
          confirmLabel={bulkConfirm === 'delete' ? `Delete ${selection.size}` : `Restart ${selection.size}`}
          body={
            <>
              <p>
                {bulkConfirm === 'delete'
                  ? `Delete ${selection.size} selected ${def.label.toLowerCase()}? This cannot be undone.`
                  : def.key === 'pods'
                    ? `Delete ${selection.size} selected pods so their controllers recreate them?`
                    : `Rollout-restart ${selection.size} selected ${def.label.toLowerCase()}?`}
              </p>
              <ul className="bulk-list">
                {[...selection.values()].slice(0, 6).map((o) => (
                  <li key={o.metadata?.uid ?? o.metadata?.name}>
                    {o.metadata?.namespace ? `${o.metadata.namespace}/` : ''}
                    {o.metadata?.name}
                  </li>
                ))}
                {selection.size > 6 && <li>... and {selection.size - 6} more</li>}
              </ul>
            </>
          }
          onConfirm={() => runBulk(bulkConfirm)}
          onCancel={() => setBulkConfirm(null)}
        />
      )}

      {pendingDelete && def && (
        <ConfirmModal
          title={`Delete ${def.kind}`}
          danger
          confirmLabel="Delete"
          body={
            <>
              Delete <strong>{pendingDelete.metadata?.name}</strong>
              {pendingDelete.metadata?.namespace ? ` in ${pendingDelete.metadata.namespace}` : ''}? This cannot be
              undone.
            </>
          }
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
