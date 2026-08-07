import type { PanopeApi } from '@shared/api'
import type { StreamChunk, WatchEvent, PortForwardInfo } from '@shared/types'

/**
 * Browser implementation of `PanopeApi`, used when the app is served by the
 * in-cluster server instead of Electron. Request/response calls go to POST
 * /rpc; the streaming ones ride a single WebSocket.
 *
 * The renderer imports `api` and never learns which transport it got.
 */

type Listener<T> = (payload: T) => void

class Socket {
  private ws?: WebSocket
  private ready?: Promise<void>
  private seq = 0
  /** ref -> resolve, for calls that must return a stream id */
  private pending = new Map<string, (id: string) => void>()
  private watchCbs = new Set<Listener<WatchEvent>>()
  private logCbs = new Set<Listener<StreamChunk>>()
  private execCbs = new Set<Listener<StreamChunk>>()

  private connect(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/`)
      this.ws = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('websocket failed'))
      ws.onclose = () => {
        // allow a later call to reconnect
        this.ready = undefined
        this.ws = undefined
      }
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string)
        switch (m.t) {
          case 'watch.started':
          case 'logs.started':
          case 'exec.started': {
            const cb = this.pending.get(m.ref)
            if (cb) {
              this.pending.delete(m.ref)
              cb(m.id)
            }
            break
          }
          case 'watch.event':
            for (const cb of this.watchCbs) cb({ subscriptionId: m.id, type: m.type, object: m.object })
            break
          case 'logs.data':
            for (const cb of this.logCbs) cb({ id: m.id, data: m.data, closed: m.closed, error: m.error })
            break
          case 'exec.data':
            for (const cb of this.execCbs) cb({ id: m.id, data: m.data, closed: m.closed, error: m.error })
            break
        }
      }
    })
    return this.ready
  }

  async send(msg: Record<string, unknown>): Promise<void> {
    await this.connect()
    this.ws?.send(JSON.stringify(msg))
  }

  /** Send a message and wait for the server to hand back a stream id. */
  async request(msg: Record<string, unknown>): Promise<string> {
    await this.connect()
    const ref = `r${++this.seq}`
    return new Promise<string>((resolve) => {
      this.pending.set(ref, resolve)
      this.ws?.send(JSON.stringify({ ...msg, ref }))
    })
  }

  onWatch(cb: Listener<WatchEvent>): () => void {
    this.watchCbs.add(cb)
    void this.connect()
    return () => this.watchCbs.delete(cb)
  }
  onLog(cb: Listener<StreamChunk>): () => void {
    this.logCbs.add(cb)
    void this.connect()
    return () => this.logCbs.delete(cb)
  }
  onExec(cb: Listener<StreamChunk>): () => void {
    this.execCbs.add(cb)
    void this.connect()
    return () => this.execCbs.delete(cb)
  }
}

const socket = new Socket()

async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const res = await fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args })
  })
  const body = (await res.json()) as { result?: T; error?: string }
  if (body.error) throw new Error(body.error)
  return body.result as T
}

/** Mutations return MutationResult rather than throwing, matching the desktop bridge. */
async function mutate(method: string, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> {
  try {
    await rpc(method, ...args)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const notSupported = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available in the in-cluster deployment.`)
}

export const webApi: PanopeApi = {
  listContexts: () => rpc('listContexts'),
  getClusterInfo: () => rpc('getClusterInfo'),
  setContext: async () => ({ ok: false, error: 'Context switching is a desktop-only feature.' }),
  getNamespaces: () => rpc('getNamespaces'),
  fleetSummary: async () => [],
  ping: () => rpc('ping'),

  listResource: (key) => rpc('listResource', key),
  countResource: (key) => rpc('countResource', key),
  getResource: (key, name, ns) => rpc('getResource', key, name, ns),
  getMetrics: (kind) => rpc('getMetrics', kind),
  getEvents: (name, ns, kind) => rpc('getEvents', name, ns, kind),

  listCRDs: () => rpc('listCRDs'),
  listCustom: (ref) => rpc('listCustom', ref),
  startWatchCustom: (ref) => socket.request({ t: 'watch.startCustom', ref2: ref }),
  listHelmRepos: () => rpc('listHelmRepos'),

  applyYaml: (yaml, opts) => mutate('applyYaml', yaml, opts),
  deleteResource: (key, name, ns) => mutate('deleteResource', key, name, ns),
  deleteCustom: (ref, name, ns) => mutate('deleteCustom', ref, name, ns),
  scaleResource: (key, name, ns, replicas) => mutate('scaleResource', key, name, ns, replicas),
  restartResource: (key, name, ns) => mutate('restartResource', key, name, ns),
  patchMerge: (key, name, ns, patch) => mutate('patchMerge', key, name, ns, patch),
  drainNode: (name) => mutate('drainNode', name),
  nodeShell: (node) => rpc('nodeShell', node),
  debugPod: (ns, name) => rpc('debugPod', ns, name),
  rollbackDeployment: (name, ns) => mutate('rollbackDeployment', name, ns),
  triggerCronJob: (name, ns) => mutate('triggerCronJob', name, ns),
  rerunJob: (name, ns) => mutate('rerunJob', name, ns),

  helmUninstall: (name, ns) => mutate('helmUninstall', name, ns),
  helmRollback: (name, ns, rev) => mutate('helmRollback', name, ns, rev),
  helmHistory: (name, ns) => rpc('helmHistory', name, ns),
  helmGet: (name, ns, what) => rpc('helmGet', name, ns, what),

  argoSync: (ns, name) => mutate('argoSync', ns, name),
  argoRefresh: (ns, name) => mutate('argoRefresh', ns, name),

  canI: (checks, as) => rpc('canI', checks, as),
  whoAmI: () => rpc('whoAmI'),
  auditLog: () => rpc('auditLog'),

  podExecCapture: (ns, pod, container, command) => rpc('podExecCapture', ns, pod, container, command),
  podWriteFile: (ns, pod, container, path, b64) => mutate('podWriteFile', ns, pod, container, path, b64),

  helmInstall: (spec) => mutate('helmInstall', spec),
  helmUpgrade: (spec) => mutate('helmUpgrade', spec),
  helmShowValues: (chart, version) => rpc('helmShowValues', chart, version),

  // one context in-cluster - nothing to compare against
  getResourceInContext: async () => null,

  // The server reads one kubeconfig (or its ServiceAccount); there is no local
  // filesystem for a browser user to point at.
  listKubeconfigs: async () => [],
  addKubeconfig: async () => ({ ok: false, error: 'Kubeconfig files are a desktop-only feature.' }),
  removeKubeconfig: async () => ({ ok: false, error: 'Kubeconfig files are a desktop-only feature.' }),
  browseForKubeconfig: async () => null,

  startWatch: (key) => socket.request({ t: 'watch.start', key }),
  stopWatch: async (id) => socket.send({ t: 'watch.stop', id }),
  onWatchEvent: (cb) => socket.onWatch(cb),

  logsStart: (namespace, pod, query) => socket.request({ t: 'logs.start', namespace, pod, query }),
  logsStop: async (id) => socket.send({ t: 'logs.stop', id }),
  onLogData: (cb) => socket.onLog(cb),

  execStart: (namespace, pod, container, command) =>
    socket.request({ t: 'exec.start', namespace, pod, container, command }),
  execInput: async (id, data) => socket.send({ t: 'exec.input', id, data }),
  execResize: async (id, cols, rows) => socket.send({ t: 'exec.resize', id, cols, rows }),
  execStop: async (id) => socket.send({ t: 'exec.stop', id }),
  onExecData: (cb) => socket.onExec(cb),

  // Forwarding to the server pod's localhost would be useless to a browser user.
  pfStart: notSupported('Port forwarding') as unknown as PanopeApi['pfStart'],
  pfStartService: notSupported('Port forwarding') as unknown as PanopeApi['pfStartService'],
  pfStop: async () => undefined,
  pfList: async (): Promise<PortForwardInfo[]> => [],
  onPfEvent: () => () => undefined,

  // The assistant is desktop-only: the server would have to hold a shared
  // model key and proxy mutations for every user, which is a different design.
  aiSend: notSupported('The AI assistant'),
  aiStop: async () => undefined,
  aiConfirm: async () => undefined,
  aiReset: async () => undefined,
  aiHistory: async () => [],
  aiListModels: async () => [],
  aiMcpStatus: async () => [],
  aiGetConfig: async () => null,
  aiSetConfig: notSupported('The AI assistant'),
  onAiEvent: () => () => undefined,

  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  getAppInfo: () => rpc('getAppInfo'),
  // There is no native menu in a browser; the in-app account menu covers it.
  onMenuAction: () => () => undefined,
  getReadOnly: async () => {
    const me = (await fetch('/auth/me').then((r) => r.json())) as { readOnly?: boolean }
    return me.readOnly !== false
  },
  setReadOnly: async () => {
    throw new Error('Read-only mode is set by the deployment, not the UI.')
  },
  // In-cluster, the image tag is the operator's call - upgrading is `helm
  // upgrade`, not something a browser tab should nag about.
  checkForUpdate: async () => ({ current: '', newer: false, error: 'managed by the deployment' }),
  onKubeconfigChanged: () => () => undefined
}
