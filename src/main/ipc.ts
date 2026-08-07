import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  webContents,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents
} from 'electron'
import { watch, existsSync, mkdirSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadSettings, saveSetting } from './settings'
import { recordAudit, auditEntries } from './audit'
import { checkForUpdate } from './update'
import { AiSession } from './ai/session'
import { listModels, type ProviderSettings } from './ai/provider'
import { IPC } from '../shared/ipc'
import type {
  AccessCheck,
  AccessSubject,
  ApplyOptions,
  CustomRef,
  HelmChartSpec,
  LogQuery,
  MutationResult,
  PortForwardInfo,
  StreamChunk,
  WatchEvent,
  AiConfig,
  AiUiContext
} from '../shared/types'
import {
  KubernetesService,
  type ExecHandle,
  type PfHandle,
  type StreamHandle,
  type WatchSession
} from './kube/client'

// ---- runtime read-only mode --------------------------------------------
// Persisted in userData so it survives restarts; enforced HERE in the main
// process (the renderer only mirrors it for UX). Covers mutations, exec and
// port-forwarding.
let readOnly = loadSettings().readOnly === true

/** Panope's own version. app.getVersion() reports Electron's version when the
 *  app runs unpackaged (there is no app package.json next to the entrypoint),
 *  which made the About dialog claim "43.2.0" in development. Read our
 *  package.json first and only trust app.getVersion() when packaged. */
function ownVersion(): string {
  if (!app.isPackaged) {
    try {
      const { version } = require(join(__dirname, '../../package.json')) as { version?: string }
      if (version) return version
    } catch {
      /* fall through to Electron's answer */
    }
  }
  return app.getVersion()
}

function saveReadOnly(value: boolean): void {
  readOnly = value
  saveSetting('readOnly', value)
}

/** User-added kubeconfig paths, on top of $KUBECONFIG / ~/.kube/config. */
function readKubeconfigPaths(): string[] {
  const raw = loadSettings().kubeconfigPaths
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
}

function persistKubeconfigPaths(paths: string[]): void {
  saveSetting('kubeconfigPaths', paths)
}

const svc = new KubernetesService()

interface Owned<T> {
  handle: T
  wcId: number
}

const watches = new Map<string, Owned<WatchSession>>()
const logs = new Map<string, Owned<StreamHandle>>()
const execs = new Map<string, Owned<ExecHandle>>()
const pfs = new Map<string, Owned<PfHandle>>()

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}${counter}_${Math.floor(Math.random() * 1e6)}`
}

function cleanupFor(wc: WebContents): void {
  for (const map of [watches, logs, execs, pfs]) {
    for (const [id, owned] of map) {
      if (owned.wcId === wc.id) {
        try {
          owned.handle.stop()
        } catch {
          /* ignore */
        }
        map.delete(id)
      }
    }
  }
}

const trackedWcs = new Set<number>()
function trackWc(wc: WebContents): void {
  if (trackedWcs.has(wc.id)) return
  trackedWcs.add(wc.id)
  wc.once('destroyed', () => {
    cleanupFor(wc)
    trackedWcs.delete(wc.id)
  })
}

const READONLY_MSG = 'Panope is in read-only mode (unlock it in Preferences or the top bar).'
function guard(): MutationResult | null {
  if (readOnly) return { ok: false, error: READONLY_MSG }
  return null
}
function toResult(p: Promise<unknown>): Promise<MutationResult> {
  return p.then(
    () => ({ ok: true }),
    (e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })
  )
}

/** toResult + audit-trail entry (mutations only). */
function audited(method: string, target: string, p: Promise<unknown>): Promise<MutationResult> {
  return toResult(p).then((res) => {
    recordAudit(method, target, res.ok, res.error)
    return res
  })
}

const nsName = (ns: string | undefined, name: string): string => (ns ? `${ns}/${name}` : name)

/** True only if `id` exists in `map` AND belongs to the calling WebContents. */
function owns<T>(e: IpcMainInvokeEvent, map: Map<string, Owned<T>>, id: string): Owned<T> | null {
  const owned = map.get(id)
  return owned && owned.wcId === e.sender.id ? owned : null
}

/** Stop every live stream (watches, logs, execs, port-forwards), notifying
 *  renderers, so nothing keeps talking to the previous cluster after a
 *  context switch. */
function stopAllStreams(reason: string): void {
  for (const [id, owned] of logs) {
    try {
      owned.handle.stop()
    } catch { /* ignore */ }
    sendTo(owned.wcId, IPC.logsData, { id, closed: true, error: reason } as StreamChunk)
    logs.delete(id)
  }
  for (const [id, owned] of execs) {
    try {
      owned.handle.stop()
    } catch { /* ignore */ }
    sendTo(owned.wcId, IPC.execData, { id, closed: true, error: reason } as StreamChunk)
    execs.delete(id)
  }
  for (const [id, owned] of pfs) {
    try {
      owned.handle.stop()
    } catch { /* ignore */ }
    sendTo(owned.wcId, IPC.pfEvent, { ...owned.handle.info, error: reason })
    pfs.delete(id)
  }
  for (const [id, owned] of watches) {
    try {
      owned.handle.stop()
    } catch { /* ignore */ }
    watches.delete(id)
  }
}

function sendTo(wcId: number, channel: string, payload: unknown): void {
  const wc = webContents.fromId(wcId)
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

export function registerIpcHandlers(): void {
  // ---- context / cluster ----
  ipcMain.handle(IPC.listContexts, () => svc.listContexts())
  ipcMain.handle(IPC.getClusterInfo, () => svc.getClusterInfo())
  ipcMain.handle(IPC.getNamespaces, () => svc.getNamespaces())
  ipcMain.handle(IPC.fleetSummary, () => svc.fleetSummary())
  ipcMain.handle(IPC.ping, () => svc.ping())
  ipcMain.handle(IPC.setContext, (_e, name: string) => {
    // Kill every live stream first so nothing from the old cluster keeps
    // rendering (or worse, gets attributed to the new one).
    stopAllStreams('context switched')
    return toResult(svc.setContext(name))
  })

  // ---- resources ----
  ipcMain.handle(IPC.listResource, (_e, key: string) => svc.listResource(key))
  ipcMain.handle(IPC.countResource, (_e, key: string) => svc.countResource(key))
  ipcMain.handle(IPC.getResource, (_e, key: string, name: string, ns?: string) =>
    svc.getResource(key, name, ns)
  )
  ipcMain.handle(IPC.getMetrics, (_e, kind: 'pods' | 'nodes') => svc.getMetrics(kind))
  ipcMain.handle(IPC.getEvents, (_e, name: string, ns?: string, kind?: string) =>
    svc.getEvents(name, ns, kind)
  )

  // ---- custom resources / CRDs ----
  ipcMain.handle(IPC.listCRDs, () => svc.listCRDs())
  ipcMain.handle(IPC.listCustom, (_e, ref: CustomRef) => svc.listCustom(ref))
  ipcMain.handle(IPC.listHelmRepos, () => svc.listHelmRepos())

  // ---- mutations ----
  ipcMain.handle(IPC.applyYaml, (_e, text: string, opts?: ApplyOptions) =>
    // dry-runs change nothing - not audit-worthy
    guard() ?? (opts?.dryRun ? toResult(svc.applyYaml(text, opts)) : audited('applyYaml', 'yaml manifest', svc.applyYaml(text, opts)))
  )
  ipcMain.handle(IPC.deleteResource, (_e, key: string, name: string, ns?: string) =>
    guard() ?? audited('deleteResource', `${key} ${nsName(ns, name)}`, svc.deleteResource(key, name, ns))
  )
  ipcMain.handle(IPC.deleteCustom, (_e, ref: CustomRef, name: string, ns?: string) =>
    guard() ?? audited('deleteCustom', `${ref.plural}.${ref.group} ${nsName(ns, name)}`, svc.deleteCustom(ref, name, ns))
  )
  ipcMain.handle(IPC.scaleResource, (_e, key: string, name: string, ns: string | undefined, replicas: number) =>
    guard() ?? audited('scaleResource', `${key} ${nsName(ns, name)} -> ${replicas}`, svc.scaleResource(key, name, ns, replicas))
  )
  ipcMain.handle(IPC.restartResource, (_e, key: string, name: string, ns?: string) =>
    guard() ?? audited('restartResource', `${key} ${nsName(ns, name)}`, svc.restartResource(key, name, ns))
  )
  ipcMain.handle(IPC.patchMerge, (_e, key: string, name: string, ns: string | undefined, patch: object) =>
    guard() ?? audited('patchMerge', `${key} ${nsName(ns, name)}`, svc.patchMerge(key, name, ns, patch))
  )
  ipcMain.handle(IPC.drainNode, (_e, name: string) => guard() ?? audited('drainNode', name, svc.drainNode(name)))
  ipcMain.handle(IPC.nodeShell, async (_e, node: string) => {
    if (readOnly) return { ok: false, error: READONLY_MSG }
    try {
      const pod = await svc.nodeShell(node)
      recordAudit('nodeShell', node, true)
      return { ok: true, pod }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      recordAudit('nodeShell', node, false, msg)
      return { ok: false, error: msg }
    }
  })
  ipcMain.handle(IPC.debugPod, async (_e, namespace: string, name: string) => {
    if (readOnly) return { ok: false, error: READONLY_MSG }
    try {
      const container = await svc.debugPod(namespace, name)
      recordAudit('debugPod', nsName(namespace, name), true)
      return { ok: true, container }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      recordAudit('debugPod', nsName(namespace, name), false, msg)
      return { ok: false, error: msg }
    }
  })
  ipcMain.handle(IPC.rollbackDeployment, (_e, name: string, ns: string) =>
    guard() ?? audited('rollbackDeployment', nsName(ns, name), svc.rollbackDeployment(name, ns))
  )
  ipcMain.handle(IPC.triggerCronJob, (_e, name: string, ns: string) =>
    guard() ?? audited('triggerCronJob', nsName(ns, name), svc.triggerCronJob(name, ns))
  )
  ipcMain.handle(IPC.rerunJob, (_e, name: string, ns: string) =>
    guard() ?? audited('rerunJob', nsName(ns, name), svc.rerunJob(name, ns))
  )

  // ---- helm lifecycle ----
  ipcMain.handle(IPC.helmUninstall, (_e, name: string, ns: string) =>
    guard() ?? audited('helmUninstall', nsName(ns, name), svc.helmUninstall(name, ns))
  )
  ipcMain.handle(IPC.helmRollback, (_e, name: string, ns: string, rev: number) =>
    guard() ?? audited('helmRollback', `${nsName(ns, name)} -> rev ${rev}`, svc.helmRollback(name, ns, rev))
  )
  ipcMain.handle(IPC.helmHistory, (_e, name: string, ns: string) => svc.helmHistory(name, ns))
  ipcMain.handle(IPC.helmGet, (_e, name: string, ns: string, what: 'values' | 'manifest' | 'notes') =>
    svc.helmGet(name, ns, what)
  )
  ipcMain.handle(IPC.helmInstall, (_e, spec: HelmChartSpec) =>
    guard() ?? audited('helmInstall', `${spec.chart} as ${nsName(spec.namespace, spec.release)}`, svc.helmInstall(spec))
  )
  ipcMain.handle(IPC.helmUpgrade, (_e, spec: HelmChartSpec) =>
    guard() ?? audited('helmUpgrade', `${nsName(spec.namespace, spec.release)} -> ${spec.chart}${spec.version ? '@' + spec.version : ''}`, svc.helmUpgrade(spec))
  )
  ipcMain.handle(IPC.helmShowValues, (_e, chart: string, version?: string) => svc.helmShowValues(chart, version))

  // ---- argocd ----
  ipcMain.handle(IPC.argoSync, (_e, ns: string, name: string) =>
    guard() ?? audited('argoSync', nsName(ns, name), svc.argoSync(ns, name))
  )
  ipcMain.handle(IPC.argoRefresh, (_e, ns: string, name: string) =>
    guard() ?? audited('argoRefresh', nsName(ns, name), svc.argoRefresh(ns, name))
  )

  // ---- access / RBAC introspection ----
  ipcMain.handle(IPC.canI, (_e, checks: AccessCheck[], as?: AccessSubject) => svc.canI(checks, as))
  ipcMain.handle(IPC.whoAmI, () => svc.whoAmI())

  // ---- audit trail ----
  ipcMain.handle(IPC.auditLog, () => auditEntries())

  // ---- pod files (non-interactive exec) ----
  // Exec in a container is write-capable access, so it honours read-only mode
  // exactly like the interactive terminal and podWriteFile do.
  ipcMain.handle(IPC.podExecCapture, async (_e, ns: string, pod: string, container: string, command: string[]) => {
    if (readOnly) throw new Error(READONLY_MSG)
    // This is the read-only file browser path (ls, base64-read). The write
    // program truncates a file and belongs to the audited podWriteFile, so it
    // must not slip through here unrecorded.
    if (command[2] === 'base64 -d > "$0"') throw new Error('Use podWriteFile to write a file.')
    return svc.execCapture(ns, pod, container, command)
  })
  ipcMain.handle(IPC.podWriteFile, async (_e, ns: string, pod: string, container: string, path: string, b64: string) => {
    const blocked = guard()
    if (blocked) return blocked
    return audited(
      'podWriteFile',
      `${nsName(ns, pod)}:${path}`,
      svc
        .execCapture(ns, pod, container, ['sh', '-c', `base64 -d > "$0"`, path], { stdin: b64, timeoutMs: 60000 })
        .then((r) => {
          if (r.code !== 0) throw new Error(r.err || `write failed (exit ${r.code})`)
        })
    )
  })

  // ---- cross-context reads ----
  ipcMain.handle(IPC.getResourceInContext, (_e, context: string, key: string, name: string, ns?: string) =>
    svc.getResourceInContext(context, key, name, ns)
  )

  // ---- watch (list views) ----
  ipcMain.handle(IPC.startWatch, async (e: IpcMainInvokeEvent, key: string): Promise<string> => {
    const wc = e.sender
    trackWc(wc)
    const id = nextId('w')
    const session = await svc.createWatch(key, (type, object) => {
      if (wc.isDestroyed()) return
      wc.send(IPC.watchEvent, { subscriptionId: id, type, object } as WatchEvent)
    })
    if (!session) return ''
    watches.set(id, { handle: session, wcId: wc.id })
    return id
  })
  ipcMain.handle(IPC.startWatchCustom, async (e: IpcMainInvokeEvent, ref: CustomRef): Promise<string> => {
    const wc = e.sender
    trackWc(wc)
    const id = nextId('wc')
    const session = await svc.createWatchCustom(ref, (type, object) => {
      if (wc.isDestroyed()) return
      wc.send(IPC.watchEvent, { subscriptionId: id, type, object } as WatchEvent)
    })
    watches.set(id, { handle: session, wcId: wc.id })
    return id
  })
  ipcMain.handle(IPC.stopWatch, (e, id: string) => {
    const owned = owns(e, watches, id)
    if (!owned) return
    owned.handle.stop()
    watches.delete(id)
  })

  // ---- logs ----
  ipcMain.handle(
    IPC.logsStart,
    async (e: IpcMainInvokeEvent, namespace: string, pod: string, query: LogQuery): Promise<string> => {
      const wc = e.sender
      trackWc(wc)
      const id = nextId('log')
      const push = (chunk: StreamChunk): void => {
        if (!wc.isDestroyed()) wc.send(IPC.logsData, chunk)
      }
      try {
        const handle = await svc.startLogs(
          namespace,
          pod,
          query,
          (data) => push({ id, data }),
          (err) => push({ id, closed: true, error: err })
        )
        logs.set(id, { handle, wcId: wc.id })
        return id
      } catch (err) {
        push({ id, closed: true, error: err instanceof Error ? err.message : String(err) })
        return id
      }
    }
  )
  ipcMain.handle(IPC.logsStop, (e, id: string) => {
    const owned = owns(e, logs, id)
    if (!owned) return
    owned.handle.stop()
    logs.delete(id)
  })

  // ---- exec / terminal ----
  ipcMain.handle(
    IPC.execStart,
    async (
      e: IpcMainInvokeEvent,
      namespace: string,
      pod: string,
      container: string,
      command: string[]
    ): Promise<string> => {
      const wc = e.sender
      trackWc(wc)
      const id = nextId('ex')
      const push = (chunk: StreamChunk): void => {
        if (!wc.isDestroyed()) wc.send(IPC.execData, chunk)
      }
      if (readOnly) {
        // A shell in a container is write access; blocked in read-only mode.
        setImmediate(() => push({ id, closed: true, error: READONLY_MSG }))
        return id
      }
      try {
        const handle = await svc.startExec(
          namespace,
          pod,
          container,
          command,
          (data) => push({ id, data }),
          (err) => push({ id, closed: true, error: err })
        )
        execs.set(id, { handle, wcId: wc.id })
        return id
      } catch (err) {
        push({ id, closed: true, error: err instanceof Error ? err.message : String(err) })
        return id
      }
    }
  )
  ipcMain.handle(IPC.execInput, (e, id: string, data: string) => owns(e, execs, id)?.handle.input(data))
  ipcMain.handle(IPC.execResize, (e, id: string, cols: number, rows: number) =>
    owns(e, execs, id)?.handle.resize(cols, rows)
  )
  ipcMain.handle(IPC.execStop, (e, id: string) => {
    const owned = owns(e, execs, id)
    if (!owned) return
    owned.handle.stop()
    execs.delete(id)
  })

  // ---- port forwarding ----
  ipcMain.handle(
    IPC.pfStart,
    async (
      e: IpcMainInvokeEvent,
      namespace: string,
      pod: string,
      remotePort: number,
      localPort?: number
    ): Promise<PortForwardInfo> => {
      const wc = e.sender
      trackWc(wc)
      const id = nextId('pf')
      if (readOnly) {
        return { id, namespace, pod, remotePort, localPort: localPort ?? 0, error: READONLY_MSG }
      }
      try {
        const handle = await svc.startPortForward(id, namespace, pod, remotePort, localPort, (info) => {
          if (!wc.isDestroyed()) wc.send(IPC.pfEvent, info)
        })
        pfs.set(id, { handle, wcId: wc.id })
        return handle.info
      } catch (err) {
        return {
          id,
          namespace,
          pod,
          remotePort,
          localPort: localPort ?? 0,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
  ipcMain.handle(
    IPC.pfStartService,
    async (
      e: IpcMainInvokeEvent,
      namespace: string,
      service: string,
      servicePort: number,
      localPort?: number
    ): Promise<PortForwardInfo> => {
      const wc = e.sender
      trackWc(wc)
      const id = nextId('pf')
      if (readOnly) {
        return { id, namespace, pod: '', service, remotePort: servicePort, localPort: localPort ?? 0, error: READONLY_MSG }
      }
      try {
        const handle = await svc.startServicePortForward(id, namespace, service, servicePort, localPort, (info) => {
          if (!wc.isDestroyed()) wc.send(IPC.pfEvent, info)
        })
        pfs.set(id, { handle, wcId: wc.id })
        return handle.info
      } catch (err) {
        return {
          id,
          namespace,
          pod: '',
          service,
          remotePort: servicePort,
          localPort: localPort ?? 0,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
  ipcMain.handle(IPC.pfStop, (e, id: string) => {
    const owned = owns(e, pfs, id)
    if (!owned) return
    owned.handle.stop()
    pfs.delete(id)
  })
  ipcMain.handle(IPC.pfList, () => Array.from(pfs.values()).map((o) => o.handle.info))

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })

  // ---- kubeconfig files (multi-file merge) ----
  ipcMain.handle(IPC.listKubeconfigs, () => svc.kubeconfigFiles())

  ipcMain.handle(IPC.addKubeconfig, async (_e, p: string): Promise<MutationResult> => {
    const file = (p ?? '').trim()
    if (!file) return { ok: false, error: 'No path given.' }
    if (!existsSync(file)) return { ok: false, error: `No such file: ${file}` }
    // Validate before persisting: adding a file that cannot be parsed would
    // otherwise show up as a broken entry on every subsequent launch.
    const probe = await svc.probeKubeconfig(file)
    if (!probe.ok) return { ok: false, error: probe.error ?? 'Not a readable kubeconfig.' }

    const current = readKubeconfigPaths()
    if (current.includes(file) || svc.kubeconfigPaths().some((k) => k.path === file)) {
      return { ok: false, error: 'That file is already in the list.' }
    }
    persistKubeconfigPaths([...current, file])
    await applyKubeconfigPaths()
    return { ok: true }
  })

  ipcMain.handle(IPC.removeKubeconfig, async (_e, p: string): Promise<MutationResult> => {
    const next = readKubeconfigPaths().filter((x) => x !== p)
    persistKubeconfigPaths(next)
    await applyKubeconfigPaths()
    return { ok: true }
  })

  ipcMain.handle(IPC.browseForKubeconfig, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts: OpenDialogOptions = {
      title: 'Add a kubeconfig file',
      defaultPath: join(homedir(), '.kube'),
      properties: ['openFile'],
      filters: [
        { name: 'kubeconfig', extensions: ['yaml', 'yml', 'config', 'kubeconfig'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
  })

  // ---- kubeconfig hot-reload ----
  // Watch every configured kubeconfig; on change reload and tell the renderer
  // so rotated credentials / new contexts appear without a restart. Watchers
  // are rebuilt whenever the file list changes.
  let watchers: FSWatcher[] = []
  let reloadTimer: ReturnType<typeof setTimeout> | undefined

  const notifyReload = (): void => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(async () => {
      try {
        const res = await svc.reloadKubeconfig()
        for (const wc of webContents.getAllWebContents()) {
          if (!wc.isDestroyed()) wc.send(IPC.kubeconfigChanged, res)
        }
      } catch (e) {
        console.error('[main] kubeconfig reload failed:', e)
      }
    }, 600)
  }

  function rewatchKubeconfigs(): void {
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        /* already gone */
      }
    }
    watchers = []
    for (const { path: file } of svc.kubeconfigPaths()) {
      if (!existsSync(file)) continue
      try {
        watchers.push(watch(file, notifyReload))
      } catch {
        /* file may vanish; watching is best-effort */
      }
    }
  }

  async function applyKubeconfigPaths(): Promise<void> {
    svc.setKubeconfigPaths(readKubeconfigPaths())
    await svc.reloadKubeconfig()
    rewatchKubeconfigs()
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(IPC.kubeconfigChanged, { currentContextStillExists: true })
    }
  }

  // Apply the persisted list at startup, then start watching.
  svc.setKubeconfigPaths(readKubeconfigPaths())
  void svc.reloadKubeconfig().then(rewatchKubeconfigs).catch(() => rewatchKubeconfigs())

  ipcMain.handle(IPC.getAppInfo, () => ({
    name: 'Panope',
    version: ownVersion(),
    mode: 'desktop' as const,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`
  }))

  // ---- AI assistant ----
  // One session; the transcript survives panel close. The API key lives in
  // settings.json and is only ever read here - the renderer gets hasKey.
  let ai: AiSession | undefined
  const aiSettings = (): ProviderSettings | null => {
    const raw = loadSettings().ai
    if (!raw || typeof raw !== 'object') return null
    const c = raw as Record<string, unknown>
    return {
      provider: c.provider === 'anthropic' ? 'anthropic' : c.provider === 'claude-code' ? 'claude-code' : 'openai',
      baseUrl: typeof c.baseUrl === 'string' && c.baseUrl ? c.baseUrl : undefined,
      model: typeof c.model === 'string' ? c.model : '',
      apiKey: typeof c.apiKey === 'string' && c.apiKey ? c.apiKey : undefined,
      mcpServers: Array.isArray(c.mcpServers) ? (c.mcpServers as ProviderSettings['mcpServers']) : [],
      unrestricted: c.unrestricted === true,
      allowedExternalTools: Array.isArray(c.allowedExternalTools) ? (c.allowedExternalTools as string[]) : []
    }
  }

  // Rebound on every send so a window reload does not orphan the event stream.
  let aiWcId = 0
  const ensureAi = (): AiSession => {
    if (!ai) {
      const cwd = join(app.getPath('userData'), 'ai-cwd')
      try {
        mkdirSync(cwd, { recursive: true })
      } catch {
        /* exists */
      }
      ai = new AiSession(
        { svc, isReadOnly: () => readOnly, audit: recordAudit },
        (ev) => sendTo(aiWcId, IPC.aiEvent, ev),
        aiSettings,
        ownVersion(),
        cwd,
        join(app.getPath('userData'), 'ai-history.json')
      )
    }
    return ai
  }
  ipcMain.handle(IPC.aiSend, (e, text: string, ctx?: AiUiContext) => {
    aiWcId = e.sender.id
    void ensureAi().send(String(text ?? ''), ctx)
  })
  ipcMain.handle(IPC.aiHistory, (e) => {
    aiWcId = e.sender.id
    return ensureAi().history()
  })
  ipcMain.handle(IPC.aiMcpStatus, (e) => {
    aiWcId = e.sender.id
    return ensureAi().externalStatus()
  })
  ipcMain.handle(IPC.aiListModels, (_e, cfg: { provider: string; baseUrl?: string; apiKey?: string }) => {
    const provider =
      cfg.provider === 'anthropic' ? 'anthropic' : cfg.provider === 'claude-code' ? 'claude-code' : 'openai'
    const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : ''
    // A key typed in the form is used as-is; otherwise fall back to the stored
    // key, but only toward the destination it was saved for.
    const prev = aiSettings()
    const stored = prev?.provider === provider && (prev?.baseUrl ?? '') === baseUrl ? prev?.apiKey : undefined
    return listModels({ provider, baseUrl: baseUrl || undefined, model: '', apiKey: cfg.apiKey || stored })
  })
  ipcMain.handle(IPC.aiStop, () => ai?.stop())
  ipcMain.handle(IPC.aiConfirm, (_e, id: string, approve: boolean, alwaysTool?: string) => {
    // Remembering an external tool is a deliberate act, so it is only recorded
    // on an approval, never on a decline or a timeout.
    if (approve === true && typeof alwaysTool === 'string' && alwaysTool) {
      const prev = aiSettings()
      const allowed = new Set(prev?.allowedExternalTools ?? [])
      allowed.add(alwaysTool)
      saveSetting('ai', { ...(loadSettings().ai as object), allowedExternalTools: [...allowed] })
    }
    ai?.confirm(String(id), approve === true)
  })
  ipcMain.handle(IPC.aiReset, () => ai?.reset())
  ipcMain.handle(IPC.aiGetConfig, (): AiConfig | null => {
    const c = aiSettings()
    if (!c || (!c.model && !c.apiKey && !c.baseUrl)) return null
    return {
      provider: c.provider,
      baseUrl: c.baseUrl,
      model: c.model,
      hasKey: !!c.apiKey,
      mcpServers: c.mcpServers ?? [],
      unrestricted: c.unrestricted === true,
      allowedExternalTools: c.allowedExternalTools ?? []
    }
  })
  ipcMain.handle(IPC.aiSetConfig, (_e, cfg: {
    provider: string
    baseUrl?: string
    model: string
    apiKey?: string
    mcpServers?: Array<{ name?: unknown; command?: unknown; args?: unknown; url?: unknown }>
    unrestricted?: boolean
    allowedExternalTools?: string[]
  }) => {
    const prev = aiSettings()
    const provider =
      cfg.provider === 'anthropic' ? 'anthropic' : cfg.provider === 'claude-code' ? 'claude-code' : 'openai'
    // baseUrl means "endpoint" for openai and "binary path" for claude-code.
    // Anthropic is pinned to its real endpoint so a value left over from
    // another provider can never redirect the key.
    const baseUrl = provider === 'anthropic' ? '' : typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : ''
    // An empty key field keeps the stored key ONLY while the destination is
    // unchanged. Repointing provider or endpoint drops it, so a key can never
    // silently follow the user to a different host.
    const sameDestination = prev?.provider === provider && (prev?.baseUrl ?? '') === baseUrl
    // External MCP servers: keep only well-formed entries. A server needs a
    // name plus either a command to spawn or a url to POST to.
    const servers = (Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [])
      .map((x) => ({
        name: typeof x?.name === 'string' ? x.name.trim() : '',
        command: typeof x?.command === 'string' && x.command.trim() ? x.command.trim() : undefined,
        args: Array.isArray(x?.args) ? (x.args as unknown[]).filter((a): a is string => typeof a === 'string') : undefined,
        url: typeof x?.url === 'string' && x.url.trim() ? x.url.trim() : undefined
      }))
      .filter((x) => x.name && (x.command || x.url))
    saveSetting('ai', {
      provider,
      baseUrl,
      model: typeof cfg.model === 'string' ? cfg.model.trim() : '',
      apiKey: cfg.apiKey ? cfg.apiKey : sameDestination ? (prev?.apiKey ?? '') : '',
      mcpServers: servers,
      unrestricted: cfg.unrestricted === true,
      // Approvals are per tool name and namespaced by server, so a changed
      // server list keeps them. The UI can send a pruned list to revoke one;
      // omitting the field leaves them untouched.
      allowedExternalTools: Array.isArray(cfg.allowedExternalTools)
        ? cfg.allowedExternalTools.filter((t): t is string => typeof t === 'string')
        : (prev?.allowedExternalTools ?? [])
    })
    // Reconnect on the next send rather than mid-conversation.
    ai?.resetExternal()
  })

  // ---- update check ----
  // Whether to check at all is the renderer's preference; this just performs it.
  ipcMain.handle(IPC.checkForUpdate, () => checkForUpdate(ownVersion()))

  // ---- read-only mode ----
  ipcMain.handle(IPC.getReadOnly, () => readOnly)
  ipcMain.handle(IPC.setReadOnly, (_e, value: boolean) => {
    saveReadOnly(value === true)
    if (readOnly) {
      // Locking must also end sessions that are already write-capable:
      // live shells and open port-forwards.
      for (const [id, owned] of execs) {
        try {
          owned.handle.stop()
        } catch { /* ignore */ }
        sendTo(owned.wcId, IPC.execData, { id, closed: true, error: READONLY_MSG } as StreamChunk)
        execs.delete(id)
      }
      for (const [id, owned] of pfs) {
        try {
          owned.handle.stop()
        } catch { /* ignore */ }
        sendTo(owned.wcId, IPC.pfEvent, { ...owned.handle.info, error: READONLY_MSG })
        pfs.delete(id)
      }
    }
    return readOnly
  })
}
