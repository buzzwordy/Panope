import { Writable, PassThrough } from 'node:stream'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import yaml from 'js-yaml'
import * as https from 'node:https'
import type * as k8s from '@kubernetes/client-node'
import { getResourceDef, type ResourceDef } from '../../shared/catalog'
import {
  mergeKubeconfigs,
  type MergeInput,
  type NamedEntry,
  type RawContext
} from './kubeconfigMerge'
import type {
  ClusterInfo,
  KubeContextInfo,
  KubeconfigFile,
  FleetCluster,
  ListResult,
  MetricsResult,
  MetricSample,
  K8sObject,
  WatchEventType,
  CrdInfo,
  CustomRef,
  PortForwardInfo,
  LogQuery
} from '../../shared/types'
import { parseCpuToMillicores, parseMemoryToBytes } from '../../shared/quantity'

type K8sModule = typeof import('@kubernetes/client-node')

// @kubernetes/client-node is ESM-only; load it via dynamic import so it works
// from the CommonJS main bundle. The promise is cached after first load.
let modPromise: Promise<K8sModule> | null = null
function loadModule(): Promise<K8sModule> {
  if (!modPromise) modPromise = import('@kubernetes/client-node')
  return modPromise
}

const execFileP = promisify(execFile)

function helmErr(e: unknown): string {
  const any = e as { code?: string; stderr?: string; message?: string }
  if (any?.code === 'ENOENT') return 'helm CLI not found in PATH. Install Helm to browse charts and releases.'
  const stderr = (any?.stderr ?? '').trim()
  if (stderr) return stderr.replace(/^Error:\s*/, '')
  return any?.message ?? String(e)
}

function errMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const any = e as { body?: unknown; code?: unknown; message?: unknown }
    if (any.body && typeof any.body === 'object' && 'message' in any.body) {
      return String((any.body as { message?: unknown }).message)
    }
    if (typeof any.body === 'string' && any.body) return any.body
    if (typeof any.code === 'number') return `HTTP ${any.code}`
    if (any.message) return String(any.message)
  }
  return String(e)
}

function tag(obj: K8sObject, kind: string, apiVersion: string): K8sObject {
  if (!obj.kind) obj.kind = kind
  if (!obj.apiVersion) obj.apiVersion = apiVersion || 'v1'
  return obj
}

function sink(onData: (s: string) => void): Writable {
  const w = new Writable({
    write(chunk, _enc, cb) {
      onData(chunk.toString('utf8'))
      cb()
    }
  })
  // Never let a source-side stream error crash the process.
  w.on('error', () => {})
  return w
}

/**
 * The only shell programs `execCapture` will run, keyed by what the pod file
 * browser needs. Each is invoked as `sh -c <program> <path>`, so the path
 * arrives as `$0` and is never interpolated into the script text - a filename
 * containing `;` or backticks is inert.
 *
 * Anything outside this set is refused. Interactive shells are unaffected: they
 * go through `startExec`, which is separately gated on read-only mode.
 */
const CAPTURE_PROGRAMS = new Set([
  'ls -la "$0"', // list a directory
  'base64 "$0"', // read a file out (binary-safe)
  'base64 -d > "$0"' // write a file in (binary-safe)
])

/** Throws unless `command` is exactly `sh -c <known program> <path>`. */
export function assertAllowedCapture(command: string[]): void {
  const bad = (why: string): never => {
    throw new Error(`Refusing to exec in pod: ${why}`)
  }
  if (!Array.isArray(command) || command.length !== 4) bad('unexpected command shape')
  const [sh, flag, program, path] = command
  if (sh !== 'sh' || flag !== '-c') bad('only "sh -c" is permitted')
  if (!CAPTURE_PROGRAMS.has(program)) bad(`program is not on the allowlist: ${JSON.stringify(program)}`)
  if (typeof path !== 'string' || !path.length) bad('missing path argument')
  // $0 is passed as its own argv entry, so no quoting concerns - but a NUL or
  // newline would still be nonsense for a path and is rejected outright.
  if (/[\0\n\r]/.test(path)) bad('path contains a control character')
}

/**
 * Sidebar counts page metadata-only listings. The per-namespace tally needs to
 * see every object, so we keep following `continue` until the budget runs out;
 * past that the total is still exact (remainingItemCount) but byNs is not, and
 * the UI drops the per-namespace badge rather than show a wrong number.
 *
 * 20 x 500 covers every kind on a normal cluster. Events on a busy one is the
 * realistic overrun, and that is the kind whose per-namespace count matters least.
 */
const COUNT_PAGE_SIZE = 500
const COUNT_MAX_PAGES = 20

export type WatchCallback = (type: WatchEventType, obj: K8sObject) => void

export interface StreamHandle {
  stop(): void
}
export interface ExecHandle extends StreamHandle {
  input(data: string): void
  resize(cols: number, rows: number): void
}
export interface PfHandle extends StreamHandle {
  info: PortForwardInfo
}

/** A single self-healing watch stream that reconnects with backoff. */
export class WatchSession {
  private abort?: AbortController
  private stopped = false
  private backoff = 500

  constructor(
    private readonly makeWatch: () => k8s.Watch,
    private readonly watchPath: string,
    private readonly kind: string,
    private readonly apiVersion: string,
    private readonly onEvent: WatchCallback
  ) {}

  start(): void {
    void this.connect()
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.watchPath) return
    const watch = this.makeWatch()
    try {
      this.abort = await watch.watch(
        this.watchPath,
        { allowWatchBookmarks: true },
        (phase: string, apiObj: unknown) => {
          this.backoff = 500
          this.onEvent(phase as WatchEventType, tag(apiObj as K8sObject, this.kind, this.apiVersion))
        },
        () => this.scheduleReconnect()
      )
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 15000)
    setTimeout(() => void this.connect(), delay)
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
  }
}

export class KubernetesService {
  private mod!: K8sModule
  private kc!: k8s.KubeConfig
  private readonly ready: Promise<void>

  constructor() {
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    this.mod = await loadModule()
    this.reloadConfig()
  }

  /**
   * Extra kubeconfig files to merge on top of the default ones, in order.
   * Set by the main process from persisted settings.
   */
  private extraPaths: string[] = []
  /** Per-file diagnostics from the last merge, for the Kubeconfigs UI. */
  private fileReport: KubeconfigFile[] = []
  /** context name -> the file it came from, shown in the context picker. */
  private contextSource = new Map<string, string>()

  setKubeconfigPaths(paths: string[]): void {
    this.extraPaths = paths.filter((p) => typeof p === 'string' && p.trim().length > 0)
  }

  /** $KUBECONFIG (colon/semicolon separated, as kubectl reads it) or ~/.kube/config. */
  private defaultPaths(): string[] {
    const env = process.env.KUBECONFIG
    if (env && env.trim()) return env.split(delimiter).map((p) => p.trim()).filter(Boolean)
    return [join(homedir(), '.kube', 'config')]
  }

  /** Every file feeding the merged config, defaults first, no duplicates. */
  kubeconfigPaths(): Array<{ path: string; isDefault: boolean }> {
    const seen = new Set<string>()
    const out: Array<{ path: string; isDefault: boolean }> = []
    for (const p of this.defaultPaths()) {
      if (seen.has(p)) continue
      seen.add(p)
      out.push({ path: p, isDefault: true })
    }
    for (const p of this.extraPaths) {
      if (seen.has(p)) continue
      seen.add(p)
      out.push({ path: p, isDefault: false })
    }
    return out
  }

  kubeconfigFiles(): KubeconfigFile[] {
    return this.fileReport
  }

  /** Parse a candidate file without adopting it, so a bad path is rejected at
   *  the point the user adds it rather than breaking every later startup. */
  async probeKubeconfig(file: string): Promise<{ ok: boolean; contexts?: string[]; error?: string }> {
    await this.ensure()
    try {
      const kc = new this.mod.KubeConfig()
      kc.loadFromFile(file)
      const contexts = kc.getContexts().map((c) => c.name)
      if (!contexts.length) return { ok: false, error: 'The file parsed but defines no contexts.' }
      return { ok: true, contexts }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Build one KubeConfig from every configured file.
   *
   * We do the merge by hand rather than leaning on loadFromDefault/mergeConfig,
   * because mergeConfig's addCluster/addUser/addContext THROW on a duplicate
   * name - and two unrelated kubeconfigs sharing a cluster called "kubernetes"
   * or a context called "default" is completely routine. One collision would
   * otherwise take out every file after it.
   *
   * Collisions follow kubectl: the first file to define a name wins. What was
   * shadowed is recorded so the UI can explain a missing context instead of
   * leaving the user to guess.
   */
  private reloadConfig(): void {
    // Parse each file independently; a missing or malformed one is reported in
    // the UI rather than taking the whole app down with it.
    const inputs: MergeInput[] = this.kubeconfigPaths().map(({ path: file, isDefault }) => {
      try {
        const one = new this.mod.KubeConfig()
        one.loadFromFile(file)
        return {
          path: file,
          isDefault,
          config: {
            clusters: (one.clusters ?? []) as unknown as NamedEntry[],
            users: (one.users ?? []) as unknown as NamedEntry[],
            contexts: (one.contexts ?? []) as unknown as RawContext[],
            currentContext: one.getCurrentContext()
          }
        }
      } catch (e) {
        return { path: file, isDefault, error: e instanceof Error ? e.message : String(e) }
      }
    })

    const merged = mergeKubeconfigs(inputs)
    const kc = new this.mod.KubeConfig()
    kc.loadFromOptions({
      clusters: merged.clusters,
      users: merged.users,
      contexts: merged.contexts,
      currentContext: merged.currentContext
    })
    this.kc = kc
    this.fileReport = merged.report
    // Rebuilt from scratch: a context removed from a file must not keep a
    // stale source attribution from the previous load.
    this.contextSource = merged.source
  }


  /** Re-read kubeconfig from disk, keeping the selected context if it still
   *  exists. Returns whether it survived the reload. */
  async reloadKubeconfig(): Promise<{ currentContextStillExists: boolean }> {
    await this.ensure()
    const current = this.kc.getCurrentContext()
    this.reloadConfig()
    const exists = this.kc.getContexts().some((c) => c.name === current)
    if (exists) this.kc.setCurrentContext(current)
    return { currentContextStillExists: exists }
  }

  private async ensure(): Promise<void> {
    await this.ready
  }

  /**
   * Identity to impersonate on every API call. Set by the in-cluster server so
   * the logged-in user's own RBAC applies instead of the ServiceAccount's.
   * Left undefined in the desktop app, where the kubeconfig user IS the caller.
   */
  private identity?: { user: string; groups: string[] }

  /** Cached wrapper so we don't rebuild it per client. */
  private impersonatedKcCache?: k8s.KubeConfig

  /**
   * Return a view of this service that impersonates `user` (+ groups).
   *
   * SECURITY: `system:`-prefixed subjects are rejected outright. Without this a
   * caller whose IdP lets them influence their own username/groups claim could
   * ask to be impersonated as `system:masters` (which bypasses RBAC entirely)
   * or as a privileged ServiceAccount, turning any login into cluster-admin.
   * The chart's RBAC `resourceNames` allowlist is the second layer; this is the
   * first, and it applies even if an operator widens the ClusterRole.
   */
  withIdentity(user: string, groups: string[] = []): KubernetesService {
    const bad = (s: string): boolean => /^system:/i.test(s.trim())
    if (!user || bad(user)) {
      throw new Error(`Refusing to impersonate reserved identity: ${user || '(empty)'}`)
    }
    const safeGroups = groups
      .map((g) => g.trim())
      .filter(Boolean)
      .filter((g) => !bad(g))
    const clone = Object.create(this) as KubernetesService
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(clone as any).identity = { user, groups: safeGroups }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(clone as any).impersonatedKcCache = undefined
    return clone
  }

  /**
   * A KubeConfig that injects Impersonate-* on EVERY outbound request.
   *
   * Impersonation is applied at the KubeConfig level rather than per generated
   * client because that is the one place every transport funnels through:
   *   - Watch and Log call config.applyToFetchOptions()
   *   - Exec and PortForward call config.applyToHTTPSOptions() (websocket)
   *   - generated API clients call config.applySecurityAuthentication()
   * Wrapping per-client previously left all four streaming paths running as the
   * ServiceAccount, ignoring the user's RBAC entirely.
   *
   * Array header values become REPEATED headers, which is what lets us send the
   * user's full group set instead of only the first one.
   */
  private impersonatedKc(): k8s.KubeConfig {
    const id = this.identity
    if (!id) return this.kc
    if (this.impersonatedKcCache) return this.impersonatedKcCache
    const base = this.kc
    const headers = (): Record<string, string | string[]> => {
      const h: Record<string, string | string[]> = { 'Impersonate-User': id.user }
      if (id.groups.length) h['Impersonate-Group'] = id.groups
      return h
    }
    const wrapper = Object.create(base) as k8s.KubeConfig
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper as any).applyToHTTPSOptions = async (opts: any): Promise<void> => {
      await base.applyToHTTPSOptions(opts)
      opts.headers = { ...(opts.headers ?? {}), ...headers() }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper as any).applySecurityAuthentication = async (ctx: any): Promise<void> => {
      await base.applySecurityAuthentication(ctx)
      // Mutate the header map directly: setHeaderParam holds one value per key,
      // but node-fetch emits an array as repeated headers.
      Object.assign(ctx.getHeaders(), headers())
    }
    this.impersonatedKcCache = wrapper
    return wrapper
  }

  /** Every API client is built from the (possibly impersonating) KubeConfig. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client<T>(Ctor: new (...args: any[]) => T): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.impersonatedKc().makeApiClient(Ctor as any) as T
  }

  private objectApi(): k8s.KubernetesObjectApi {
    return this.mod.KubernetesObjectApi.makeApiClient(this.impersonatedKc())
  }

  private makeApi<T extends k8s.ApiType>(className: string): T {
    const Ctor = (this.mod as unknown as Record<string, k8s.ApiConstructor<T>>)[className]
    if (!Ctor) throw new Error(`Unknown API client: ${className}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.client(Ctor as any) as T
  }

  /**
   * GET a raw API-server path with the user's identity and the cluster's TLS.
   *
   * node:https rather than fetch: applyToFetchOptions hands back a node-fetch
   * style `agent`, which undici (global fetch) ignores, so a cluster with a
   * private CA fails verification. applyToHTTPSOptions puts ca/cert/key on the
   * request options directly, which is the same path exec and port-forward use.
   */
  private async rawGet(path: string): Promise<unknown> {
    await this.ensure()
    const kc = this.impersonatedKc()
    const server = kc.getCurrentCluster()?.server
    if (!server) throw new Error('no current cluster')
    const url = new URL(server.replace(/\/$/, '') + path)
    const opts: https.RequestOptions = {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search
    }
    await kc.applyToHTTPSOptions(opts)
    return new Promise((resolve, reject) => {
      const req = https.request(opts, (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          res.resume()
          reject(new Error(`${path} -> ${res.statusCode}`))
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('error', reject)
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(20_000, () => req.destroy(new Error('openapi request timed out')))
      req.end()
    })
  }

  private schemaCache = new Map<string, Record<string, unknown> | null>()

  /**
   * OpenAPI v3 schemas for one apiVersion, keyed by their fully-qualified name
   * (io.k8s.api.apps.v1.Deployment ...). Cached per apiVersion. Powers the
   * YAML editor's field completion; returns null if the cluster does not serve
   * OpenAPI v3 for that group-version.
   */
  async openApiSchemas(apiVersion: string): Promise<Record<string, unknown> | null> {
    if (this.schemaCache.has(apiVersion)) return this.schemaCache.get(apiVersion) ?? null
    // core group is "v1"; everything else is "<group>/<version>"
    const path = apiVersion.includes('/')
      ? `/openapi/v3/apis/${apiVersion}`
      : `/openapi/v3/api/${apiVersion}`
    try {
      const doc = (await this.rawGet(path)) as { components?: { schemas?: Record<string, unknown> } }
      const schemas = doc?.components?.schemas ?? null
      this.schemaCache.set(apiVersion, schemas)
      return schemas
    } catch {
      // A cluster that does not serve OpenAPI v3 for this group-version just
      // means no completions; cache the miss so we do not retry per keystroke.
      this.schemaCache.set(apiVersion, null)
      return null
    }
  }

  // ---------------- contexts / cluster ----------------

  /**
   * Summarise EVERY kubeconfig context in parallel without changing the
   * current one - each probe builds its own throwaway client. Unreachable
   * clusters resolve to a row carrying the error rather than rejecting, so a
   * VPN-less context never blocks the rest of the fleet.
   */
  async fleetSummary(timeoutMs = 8000): Promise<FleetCluster[]> {
    await this.ensure()
    const contexts = this.kc.getContexts()
    return Promise.all(contexts.map((c) => this.summarizeContext(c.name, c.cluster, timeoutMs)))
  }

  private async summarizeContext(context: string, cluster: string, timeoutMs: number): Promise<FleetCluster> {
    const started = Date.now()
    const withTimeout = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs))
      ])
    try {
      // A private KubeConfig per probe - this must never mutate this.kc.
      const kc = new this.mod.KubeConfig()
      kc.loadFromDefault()
      kc.setCurrentContext(context)
      const core = kc.makeApiClient(this.mod.CoreV1Api)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodesRes = (await withTimeout(core.listNode() as any)) as any
      const nodes = (nodesRes?.items ?? []) as k8s.V1Node[]

      let nodesReady = 0
      let cpuTotal = 0
      let memTotal = 0
      let podCapacity = 0
      for (const n of nodes) {
        const conds = n.status?.conditions ?? []
        if (conds.some((c) => c.type === 'Ready' && c.status === 'True')) nodesReady++
        cpuTotal += parseCpuToMillicores(n.status?.allocatable?.cpu)
        memTotal += parseMemoryToBytes(n.status?.allocatable?.memory)
        podCapacity += Number(n.status?.allocatable?.pods ?? 0)
      }

      // Version, pods and metrics are all optional extras - a failure in any
      // of them still leaves a useful row.
      const [version, pods, metrics] = await Promise.all([
        withTimeout(kc.makeApiClient(this.mod.VersionApi).getCode())
          .then((v: k8s.VersionInfo) => v.gitVersion)
          .catch(() => undefined),
        withTimeout(core.listPodForAllNamespaces())
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((r: any) => (r?.items ?? []) as k8s.V1Pod[])
          .catch(() => null),
        withTimeout(
          kc
            .makeApiClient(this.mod.CustomObjectsApi)
            .listClusterCustomObject({ group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes' })
        ).catch(() => null)
      ])

      let podsProblem: number | undefined
      if (pods) {
        podsProblem = pods.filter((p) => {
          if (p.metadata?.deletionTimestamp) return false
          const phase = p.status?.phase
          if (phase === 'Succeeded') return false
          if (phase === 'Failed' || phase === 'Pending' || phase === 'Unknown') return true
          // Running but with a container stuck waiting / not ready
          return (p.status?.containerStatuses ?? []).some(
            (c) => !!c.state?.waiting?.reason && c.state.waiting.reason !== 'ContainerCreating'
          )
        }).length
      }

      let cpuUsed: number | undefined
      let memUsed: number | undefined
      if (metrics) {
        cpuUsed = 0
        memUsed = 0
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const item of ((metrics as any).items ?? []) as any[]) {
          cpuUsed += parseCpuToMillicores(item?.usage?.cpu)
          memUsed += parseMemoryToBytes(item?.usage?.memory)
        }
      }

      return {
        context,
        cluster,
        reachable: true,
        latencyMs: Date.now() - started,
        version,
        nodes: nodes.length,
        nodesReady,
        pods: pods?.length,
        podsProblem,
        cpuUsed,
        cpuTotal,
        memUsed,
        memTotal,
        podCapacity,
        metricsAvailable: !!metrics
      }
    } catch (e) {
      return {
        context,
        cluster,
        reachable: false,
        latencyMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  async listContexts(): Promise<KubeContextInfo[]> {
    await this.ensure()
    const current = this.kc.getCurrentContext()
    return this.kc.getContexts().map((c) => ({
      name: c.name,
      cluster: c.cluster,
      user: c.user,
      namespace: c.namespace,
      current: c.name === current,
      source: this.contextSource.get(c.name)
    }))
  }

  async setContext(name: string): Promise<void> {
    await this.ensure()
    this.kc.setCurrentContext(name)
  }

  async getClusterInfo(): Promise<ClusterInfo> {
    await this.ensure()
    const context = this.kc.getCurrentContext()
    const cluster = this.kc.getCurrentCluster()
    let version: string | undefined
    let platform: string | undefined
    try {
      const versionApi = this.client(this.mod.VersionApi)
      const info = await versionApi.getCode()
      version = info.gitVersion
      platform = info.platform
    } catch {
      /* optional */
    }
    let metricsAvailable = false
    try {
      const co = this.client(this.mod.CustomObjectsApi)
      await co.listClusterCustomObject({ group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes' })
      metricsAvailable = true
    } catch {
      metricsAvailable = false
    }
    return { context, server: cluster?.server, version, platform, metricsAvailable }
  }

  /** Connectivity probe: unlike getNamespaces (which swallows errors to []),
   *  this rejects when the API server is unreachable so the UI can go offline. */
  async ping(): Promise<void> {
    await this.ensure()
    const core = this.client(this.mod.CoreV1Api)
    await core.listNamespace({ limit: 1 })
  }

  async getNamespaces(): Promise<string[]> {
    await this.ensure()
    try {
      const core = this.client(this.mod.CoreV1Api)
      const res = await core.listNamespace()
      return (res.items ?? []).map((n) => n.metadata?.name ?? '').filter(Boolean).sort()
    } catch {
      return []
    }
  }

  // ---------------- resources ----------------

  async listResource(key: string): Promise<ListResult> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def) return { items: [], error: `Unknown resource: ${key}` }
    if (def.api === 'helm') {
      if (def.key === 'releases') return this.listHelmReleases()
      if (def.key === 'charts') return this.listHelmCharts()
      return { items: [] }
    }
    if (def.unsupported || !def.listMethod) return { items: [] }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = this.makeApi<any>(def.api)
      const res = await api[def.listMethod]()
      const items: K8sObject[] = (res?.items ?? []).map((o: K8sObject) => tag(o, def.kind, def.apiVersion))
      return { items, resourceVersion: res?.metadata?.resourceVersion }
    } catch (e) {
      return { items: [], error: errMsg(e) }
    }
  }

  /**
   * Count a resource without fetching object bodies.
   *
   * Two things make this cheap. The apiserver serves PartialObjectMetadataList
   * on request, dropping spec and status entirely - for Secrets that is the
   * whole payload, and across the sidebar's 30 kinds it took one cluster from
   * 20.5 MB to 2.0 MB. `limit` then caps the worst case, because metadata is
   * still O(n) and an Events collection can run to tens of thousands of rows.
   *
   * The exact total survives paging via metadata.remainingItemCount. byNs does
   * not: it can only reflect the page we fetched, so a truncated list is marked
   * `partial` and the UI declines to show a per-namespace number rather than
   * showing a wrong one.
   */
  async countResource(
    key: string
  ): Promise<{ total: number; byNs: Record<string, number>; partial?: boolean } | null> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def) return null

    const tally = (items: Array<{ metadata?: { namespace?: string } }>): Record<string, number> => {
      const byNs: Record<string, number> = {}
      for (const i of items) {
        const ns = i?.metadata?.namespace
        if (ns) byNs[ns] = (byNs[ns] ?? 0) + 1
      }
      return byNs
    }

    // Helm kinds are not API-server objects; they come from the helm CLI.
    if (def.api !== 'helm' && def.listMethod && !def.unsupported) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = this.makeApi<any>(def.api)
        const accept = this.mod.setHeaderOptions(
          'Accept',
          'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1'
        )
        const byNs: Record<string, number> = {}
        let seen = 0
        let cont: string | undefined
        let remaining: number | undefined
        let unbounded = false

        for (let page = 0; page < COUNT_MAX_PAGES; page++) {
          const res = await api[def.listMethod](
            { limit: COUNT_PAGE_SIZE, ...(cont ? { _continue: cont } : {}) },
            accept
          )
          // An empty PartialObjectMetadataList serialises items as null, not [].
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const items: any[] = res?.items ?? []
          const meta = res?.metadata ?? {}
          seen += items.length
          for (const i of items) {
            const ns = i?.metadata?.namespace
            if (ns) byNs[ns] = (byNs[ns] ?? 0) + 1
          }
          remaining = meta.remainingItemCount ?? undefined
          cont = (meta._continue ?? meta.continue) || undefined
          if (!cont) break
          // A truncated page with no remainingItemCount tells us nothing about
          // the total. That happens with a selector, or on apiservers before
          // 1.15; counting the long way is the only honest answer.
          if (remaining === undefined) {
            unbounded = true
            break
          }
        }

        if (!unbounded) {
          const partial = !!cont
          return {
            total: seen + (remaining ?? 0),
            byNs,
            ...(partial ? { partial: true } : {})
          }
        }
      } catch {
        // Older apiserver, or an aggregated API that does not serve
        // PartialObjectMetadata - fall through and count the long way.
      }
    }

    const res = await this.listResource(key)
    if (res.error) return null
    return { total: res.items.length, byNs: tally(res.items) }
  }

  async getResource(key: string, name: string, namespace?: string): Promise<K8sObject | null> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def || def.api === 'helm') return null
    try {
      const objApi = this.objectApi()
      const obj = await objApi.read({
        apiVersion: def.apiVersion || 'v1',
        kind: def.kind,
        metadata: { name, namespace: namespace || undefined }
      })
      return obj as K8sObject
    } catch (e) {
      throw new Error(errMsg(e))
    }
  }

  async getMetrics(kind: 'pods' | 'nodes'): Promise<MetricsResult> {
    await this.ensure()
    try {
      const co = this.client(this.mod.CustomObjectsApi)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await co.listClusterCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        plural: kind
      })) as any
      const items: any[] = res?.items ?? []
      const samples: MetricSample[] = items.map((it) => {
        let cpu = 0
        let memory = 0
        if (kind === 'pods') {
          for (const c of it.containers ?? []) {
            cpu += parseCpuToMillicores(c?.usage?.cpu)
            memory += parseMemoryToBytes(c?.usage?.memory)
          }
        } else {
          cpu = parseCpuToMillicores(it?.usage?.cpu)
          memory = parseMemoryToBytes(it?.usage?.memory)
        }
        return { namespace: it?.metadata?.namespace, name: it?.metadata?.name, cpu, memory }
      })
      return { available: true, samples }
    } catch (e) {
      return { available: false, samples: [], error: errMsg(e) }
    }
  }

  async getEvents(name: string, namespace?: string, _kind?: string): Promise<K8sObject[]> {
    await this.ensure()
    try {
      const core = this.client(this.mod.CoreV1Api)
      const fieldSelector = `involvedObject.name=${name}`
      const res = namespace
        ? await core.listNamespacedEvent({ namespace, fieldSelector })
        : await core.listEventForAllNamespaces({ fieldSelector })
      return ((res.items ?? []) as unknown as K8sObject[]).map((o) => tag(o, 'Event', 'v1'))
    } catch {
      return []
    }
  }

  // ---------------- access / RBAC introspection ----------------

  /**
   * Answer "can I / can they?" via the authorizer itself, not by reading Role
   * objects - this is the only method that accounts for every binding,
   * aggregation rule and webhook authorizer the cluster actually uses.
   *
   * Without `as`: SelfSubjectAccessReview (any authenticated caller may ask
   * about itself - under impersonation "itself" IS the impersonated user, so
   * the in-cluster server needs no extra RBAC for the common case).
   * With `as`: SubjectAccessReview, which requires authorization.k8s.io
   * `subjectaccessreviews create` - denials surface per-check, not as a throw.
   */
  async canI(
    checks: Array<{ verb: string; resource: string; group?: string; namespace?: string; name?: string; subresource?: string }>,
    as?: { user?: string; groups?: string[] }
  ): Promise<Array<{ allowed: boolean; reason?: string; error?: string }>> {
    await this.ensure()
    const authz = this.client(this.mod.AuthorizationV1Api)
    const askSubject = !!(as?.user || as?.groups?.length)
    return Promise.all(
      checks.map(async (c) => {
        const attrs = {
          verb: c.verb,
          resource: c.resource,
          group: c.group || '',
          namespace: c.namespace || undefined,
          name: c.name || undefined,
          subresource: c.subresource || undefined
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let status: any
          if (askSubject) {
            const res = await authz.createSubjectAccessReview({
              body: {
                spec: { user: as?.user || undefined, groups: as?.groups?.length ? as.groups : undefined, resourceAttributes: attrs }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any
            })
            status = res.status
          } else {
            const res = await authz.createSelfSubjectAccessReview({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              body: { spec: { resourceAttributes: attrs } } as any
            })
            status = res.status
          }
          return { allowed: status?.allowed === true, reason: status?.reason || undefined }
        } catch (e) {
          return { allowed: false, error: errMsg(e) }
        }
      })
    )
  }

  /** The identity the API server attributes our requests to. */
  async whoAmI(): Promise<{ user: string; groups: string[]; source: 'selfsubjectreview' | 'kubeconfig' }> {
    await this.ensure()
    try {
      // authentication.k8s.io/v1 SelfSubjectReview (k8s >=1.28)
      const auth = this.client(this.mod.AuthenticationV1Api)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await auth.createSelfSubjectReview({ body: {} as any })) as any
      const ui = res?.status?.userInfo
      if (ui?.username) {
        return { user: String(ui.username), groups: (ui.groups ?? []).map(String), source: 'selfsubjectreview' }
      }
    } catch {
      /* older cluster or RBAC-blocked - fall back to the kubeconfig's own idea */
    }
    const ctx = this.kc.getContexts().find((c) => c.name === this.kc.getCurrentContext())
    return { user: ctx?.user ?? 'unknown', groups: [], source: 'kubeconfig' }
  }

  // ---------------- custom resources / CRDs ----------------

  async listCRDs(): Promise<CrdInfo[]> {
    await this.ensure()
    try {
      const api = this.client(this.mod.ApiextensionsV1Api)
      const res = await api.listCustomResourceDefinition()
      const out: CrdInfo[] = []
      for (const crd of res.items ?? []) {
        const spec = crd.spec
        if (!spec) continue
        const versions = spec.versions ?? []
        const served = versions.find((v) => v.storage) ?? versions.find((v) => v.served) ?? versions[0]
        if (!served) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cols: any[] = (served as any).additionalPrinterColumns ?? []
        const printerColumns = cols
          .filter((c) => !c.priority || c.priority === 0)
          .map((c) => ({ name: String(c.name), jsonPath: String(c.jsonPath ?? c.JSONPath ?? '') }))
          .filter((c) => c.jsonPath)
          .slice(0, 6)
        out.push({
          group: spec.group,
          version: served.name,
          plural: spec.names.plural,
          kind: spec.names.kind,
          namespaced: spec.scope === 'Namespaced',
          categories: spec.names.categories ?? [],
          name: crd.metadata?.name ?? `${spec.names.plural}.${spec.group}`,
          printerColumns
        })
      }
      return out.sort((a, b) => (a.group + a.kind).localeCompare(b.group + b.kind))
    } catch {
      return []
    }
  }

  async listCustom(ref: CustomRef): Promise<ListResult> {
    await this.ensure()
    try {
      const co = this.client(this.mod.CustomObjectsApi)
      // Cluster-wide list endpoint returns items across all namespaces for
      // namespaced CRDs too.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await co.listClusterCustomObject({
        group: ref.group,
        version: ref.version,
        plural: ref.plural
      })) as any
      const apiVersion = ref.group ? `${ref.group}/${ref.version}` : ref.version
      const items: K8sObject[] = (res?.items ?? []).map((o: K8sObject) => tag(o, o.kind ?? '', apiVersion))
      return { items, resourceVersion: res?.metadata?.resourceVersion }
    } catch (e) {
      return { items: [], error: errMsg(e) }
    }
  }

  // ---------------- helm (via the helm CLI) ----------------

  async listHelmReleases(): Promise<ListResult> {
    await this.ensure()
    try {
      const { stdout } = await execFileP(
        'helm',
        // helmArgs so the listing is scoped to the caller's own RBAC, not the
        // ServiceAccount's - otherwise a viewer sees every release in the cluster.
        this.helmArgs(['list', '--all-namespaces', '--output', 'json']),
        { maxBuffer: 1e8, timeout: 25000 }
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (JSON.parse(stdout || '[]') as any[]) ?? []
      const items: K8sObject[] = arr.map((r) => ({
        apiVersion: 'helm',
        kind: 'Release',
        metadata: { name: r.name, namespace: r.namespace, uid: `${r.namespace}/${r.name}` },
        revision: Number(r.revision) || r.revision,
        status: r.status,
        chart: r.chart,
        appVersion: r.app_version,
        updatedText: r.updated
      }))
      return { items }
    } catch (e) {
      return { items: [], error: helmErr(e) }
    }
  }

  async listHelmRepos(): Promise<Array<{ name: string; url: string }>> {
    await this.ensure()
    try {
      const { stdout } = await execFileP('helm', ['repo', 'list', '--output', 'json'], {
        maxBuffer: 1e7,
        timeout: 15000
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (JSON.parse(stdout || '[]') as any[]) ?? []
      return arr.map((r) => ({ name: r.name, url: r.url }))
    } catch {
      return [] // "no repositories" exits non-zero - treat as empty
    }
  }

  async listHelmCharts(): Promise<ListResult> {
    await this.ensure()
    try {
      const { stdout } = await execFileP('helm', ['search', 'repo', '--output', 'json'], {
        maxBuffer: 1e8,
        timeout: 25000
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (JSON.parse(stdout || '[]') as any[]) ?? []
      const items: K8sObject[] = arr.map((c) => ({
        apiVersion: 'helm',
        kind: 'Chart',
        metadata: { name: c.name, uid: `${c.name}@${c.version}` },
        chartVersion: c.version,
        appVersion: c.app_version,
        description: c.description
      }))
      return { items }
    } catch (e) {
      return { items: [], error: helmErr(e) }
    }
  }

  /**
   * Common flags for every `helm` invocation.
   *
   * SECURITY: helm is a child process with its own connection to the API
   * server, so it does NOT inherit the impersonation applied to our KubeConfig
   * - without these flags every Helm action a web user takes would run as the
   * pod's ServiceAccount, which is exactly the escalation the in-cluster
   * deployment promises cannot happen. `--kube-as-user` / `--kube-as-group`
   * make the apiserver apply the user's own RBAC, same as the other transports.
   */
  private helmArgs(extra: string[]): string[] {
    return [...extra, '--kube-context', this.kc.getCurrentContext(), ...this.helmIdentityArgs()]
  }

  private helmIdentityArgs(): string[] {
    const id = this.identity
    if (!id?.user) return []
    const out = ['--kube-as-user', id.user]
    for (const g of id.groups) out.push('--kube-as-group', g)
    return out
  }

  async helmUninstall(name: string, namespace: string): Promise<void> {
    await this.ensure()
    try {
      await execFileP('helm', this.helmArgs(['uninstall', name, '--namespace', namespace]), { timeout: 60000 })
    } catch (e) {
      throw new Error(helmErr(e))
    }
  }

  async helmRollback(name: string, namespace: string, revision: number): Promise<void> {
    await this.ensure()
    try {
      await execFileP('helm', this.helmArgs(['rollback', name, String(revision), '--namespace', namespace]), {
        timeout: 120000
      })
    } catch (e) {
      throw new Error(helmErr(e))
    }
  }

  async helmHistory(name: string, namespace: string): Promise<Array<Record<string, unknown>>> {
    await this.ensure()
    try {
      const { stdout } = await execFileP(
        'helm',
        this.helmArgs(['history', name, '--namespace', namespace, '--output', 'json']),
        { maxBuffer: 1e7, timeout: 20000 }
      )
      return (JSON.parse(stdout || '[]') as Array<Record<string, unknown>>) ?? []
    } catch {
      return []
    }
  }

  async helmGet(name: string, namespace: string, what: 'values' | 'manifest' | 'notes'): Promise<string> {
    await this.ensure()
    try {
      const args = what === 'values' ? ['get', 'values', name] : ['get', what, name]
      const { stdout } = await execFileP('helm', this.helmArgs([...args, '--namespace', namespace]), {
        maxBuffer: 1e8,
        timeout: 20000
      })
      return stdout || ''
    } catch (e) {
      return helmErr(e)
    }
  }

  /** Reads the chart's own values from the repository - no cluster contact, so
   *  deliberately no helmArgs()/impersonation (there is nothing to authorize). */
  async helmShowValues(chart: string, version?: string): Promise<string> {
    await this.ensure()
    try {
      const args = ['show', 'values', chart, ...(version ? ['--version', version] : [])]
      const { stdout } = await execFileP('helm', args, { maxBuffer: 1e8, timeout: 30000 })
      return stdout || ''
    } catch (e) {
      throw new Error(helmErr(e))
    }
  }

  /** Shared install/upgrade runner. Values ride a temp file (helm has no
   *  stdin-values flag that execFile can feed portably). */
  private async helmDeploy(
    verb: 'install' | 'upgrade',
    spec: { release: string; chart: string; namespace: string; values?: string; version?: string }
  ): Promise<void> {
    await this.ensure()
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join: joinPath } = await import('node:path')
    let dir: string | undefined
    try {
      const args = [verb, spec.release, spec.chart, '--namespace', spec.namespace]
      if (verb === 'install') args.push('--create-namespace')
      if (spec.version) args.push('--version', spec.version)
      if (spec.values?.trim()) {
        dir = await mkdtemp(joinPath(tmpdir(), 'panope-helm-'))
        const vf = joinPath(dir, 'values.yaml')
        await writeFile(vf, spec.values, 'utf8')
        args.push('--values', vf)
      }
      await execFileP('helm', this.helmArgs(args), { maxBuffer: 1e7, timeout: 300000 })
    } catch (e) {
      throw new Error(helmErr(e))
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  helmInstall(spec: { release: string; chart: string; namespace: string; values?: string; version?: string }): Promise<void> {
    return this.helmDeploy('install', spec)
  }

  helmUpgrade(spec: { release: string; chart: string; namespace: string; values?: string; version?: string }): Promise<void> {
    return this.helmDeploy('upgrade', spec)
  }

  // ---------------- argocd ----------------

  private async patchApplication(namespace: string, name: string, patch: object): Promise<void> {
    await this.ensure()
    const objApi = this.objectApi()
    await objApi.patch(
      {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name, namespace },
        ...patch
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      this.mod.PatchStrategy.MergePatch
    )
  }

  async argoSync(namespace: string, name: string): Promise<void> {
    await this.patchApplication(namespace, name, {
      operation: {
        initiatedBy: { username: 'panope', automated: false },
        sync: { syncStrategy: { hook: { force: false } } }
      }
    })
  }

  async argoRefresh(namespace: string, name: string): Promise<void> {
    await this.patchApplication(namespace, name, {
      metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } }
    })
  }

  // ---------------- mutations ----------------

  async applyYaml(text: string, opts?: { dryRun?: boolean; force?: boolean }): Promise<void> {
    await this.ensure()
    const objApi = this.objectApi()
    const docs = (yaml.loadAll(text) as unknown[]).filter(
      (d) => d && typeof d === 'object'
    ) as k8s.KubernetesObject[]
    if (!docs.length) throw new Error('No valid YAML documents to apply')
    // Multi-doc manifests can have intra-file dependencies (a Namespace plus
    // resources inside it) that a dry-run would false-fail on - skip the
    // preflight there and apply directly.
    if (opts?.dryRun && docs.length > 1) return
    for (const spec of docs) {
      // Server-side apply: create or update in one call. Field-manager conflicts
      // are NOT forced by default - the caller opts into force after seeing them.
      await objApi.patch(
        spec,
        undefined,
        opts?.dryRun ? 'All' : undefined,
        'panope',
        opts?.force ?? false,
        this.mod.PatchStrategy.ServerSideApply
      )
    }
  }

  async deleteResource(key: string, name: string, namespace?: string): Promise<void> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def) throw new Error(`Unknown resource: ${key}`)
    const objApi = this.objectApi()
    await objApi.delete({
      apiVersion: def.apiVersion || 'v1',
      kind: def.kind,
      metadata: { name, namespace: namespace || undefined }
    })
  }

  async deleteCustom(ref: CustomRef, name: string, namespace?: string): Promise<void> {
    await this.ensure()
    const co = this.client(this.mod.CustomObjectsApi)
    if (ref.namespaced && namespace) {
      await co.deleteNamespacedCustomObject({
        group: ref.group,
        version: ref.version,
        namespace,
        plural: ref.plural,
        name
      })
    } else {
      await co.deleteClusterCustomObject({
        group: ref.group,
        version: ref.version,
        plural: ref.plural,
        name
      })
    }
  }

  async scaleResource(key: string, name: string, namespace: string | undefined, replicas: number): Promise<void> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def) throw new Error(`Unknown resource: ${key}`)
    const objApi = this.objectApi()
    await objApi.patch(
      {
        apiVersion: def.apiVersion || 'apps/v1',
        kind: def.kind,
        metadata: { name, namespace: namespace || undefined },
        spec: { replicas }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      this.mod.PatchStrategy.MergePatch
    )
  }

  /** Rollout restart: stamp the pod-template restartedAt annotation (like kubectl). */
  async restartResource(key: string, name: string, namespace?: string): Promise<void> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def) throw new Error(`Unknown resource: ${key}`)
    const objApi = this.objectApi()
    await objApi.patch(
      {
        apiVersion: def.apiVersion || 'apps/v1',
        kind: def.kind,
        metadata: { name, namespace: namespace || undefined },
        spec: {
          template: {
            metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } }
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      this.mod.PatchStrategy.MergePatch
    )
  }

  /** Generic strategic/merge patch - used for cordon, pause/resume, suspend, etc. */
  async patchMerge(key: string, name: string, namespace: string | undefined, patch: object): Promise<void> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def) throw new Error(`Unknown resource: ${key}`)
    const objApi = this.objectApi()
    await objApi.patch(
      {
        apiVersion: def.apiVersion || 'v1',
        kind: def.kind,
        metadata: { name, namespace: namespace || undefined },
        ...patch
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      this.mod.PatchStrategy.MergePatch
    )
  }

  /** Cordon a node then evict its pods (best-effort), like `kubectl drain`. */
  async drainNode(name: string): Promise<void> {
    await this.ensure()
    const core = this.client(this.mod.CoreV1Api)
    await this.patchMerge('nodes', name, undefined, { spec: { unschedulable: true } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pods = (await core.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${name}` })) as any
    for (const p of pods?.items ?? []) {
      const podName = p?.metadata?.name
      const ns = p?.metadata?.namespace
      const ownerKind = p?.metadata?.ownerReferences?.[0]?.kind
      if (!podName || !ns || ownerKind === 'DaemonSet') continue // skip mirror/DS pods
      try {
        await core.createNamespacedPodEviction({
          namespace: ns,
          name: podName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: podName, namespace: ns } } as any
        })
      } catch {
        /* best-effort; PDBs or already-gone pods are ignored */
      }
    }
  }

  /** Roll a Deployment back to its previous ReplicaSet's pod template (kubectl rollout undo). */
  async rollbackDeployment(name: string, namespace: string): Promise<void> {
    await this.ensure()
    const apps = this.client(this.mod.AppsV1Api)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dep = (await apps.readNamespacedDeployment({ name, namespace })) as any
    const curRev = Number(dep?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rsList = (await apps.listNamespacedReplicaSet({ namespace })) as any
    const owned = (rsList?.items ?? []).filter((rs: any) =>
      (rs.metadata?.ownerReferences ?? []).some((o: any) => o.kind === 'Deployment' && o.name === name)
    )
    const prev = owned
      .map((rs: any) => ({ rs, rev: Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0) }))
      .filter((x: any) => x.rev > 0 && x.rev < curRev)
      .sort((a: any, b: any) => b.rev - a.rev)[0]
    if (!prev) throw new Error('No previous revision to roll back to.')
    const template = prev.rs.spec?.template
    if (!template) throw new Error('Previous ReplicaSet has no pod template.')
    await this.patchMerge('deployments', name, namespace, { spec: { template } })
  }

  /** Create a one-off Job from a CronJob's jobTemplate (kubectl create job --from=cronjob). */
  /** Create (or reuse) a privileged host pod on `node` for a root shell.
   *  The pod self-destructs via `sleep` timeout; the caller execs nsenter. */
  async nodeShell(node: string): Promise<K8sObject> {
    await this.ensure()
    const core = this.client(this.mod.CoreV1Api)
    const namespace = 'kube-system'
    // Sanitizing/truncating a long node name can collide (two nodes -> same pod
    // -> shell on the WRONG node). Append a short deterministic hash of the FULL
    // name so distinct nodes always get distinct pods.
    let h = 0
    for (let i = 0; i < node.length; i++) h = (h * 31 + node.charCodeAt(i)) >>> 0
    const hash = h.toString(36)
    const safe = node.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
    const podName = `panope-node-shell-${safe}`.slice(0, 63 - hash.length - 1) + '-' + hash

    // reuse a still-running shell pod
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = (await core.readNamespacedPod({ name: podName, namespace })) as any
      if (existing?.status?.phase === 'Running') return existing as K8sObject
      await core.deleteNamespacedPod({ name: podName, namespace, gracePeriodSeconds: 0 })
      await new Promise((r) => setTimeout(r, 1500))
    } catch {
      /* not found - create fresh */
    }

    await core.createNamespacedPod({
      namespace,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: podName, namespace, labels: { 'app.kubernetes.io/managed-by': 'panope' } },
        spec: {
          nodeName: node,
          hostPID: true,
          hostNetwork: true,
          restartPolicy: 'Never',
          tolerations: [{ operator: 'Exists' }],
          // self-cleanup after an hour even if the app dies
          activeDeadlineSeconds: 3600,
          containers: [
            {
              name: 'shell',
              image: 'busybox:1.36',
              command: ['sleep', '3600'],
              securityContext: { privileged: true },
              stdin: true
            }
          ]
        }
      } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    })

    // wait for Running (image pull can take a moment)
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pod = (await core.readNamespacedPod({ name: podName, namespace })) as any
      if (pod?.status?.phase === 'Running') return pod as K8sObject
      const waiting = pod?.status?.containerStatuses?.[0]?.state?.waiting
      if (waiting && /BackOff|Err/.test(waiting.reason ?? '')) {
        throw new Error(`node shell pod failed: ${waiting.reason} - ${waiting.message ?? ''}`)
      }
    }
    throw new Error('node shell pod did not become Running within 40s')
  }

  /** Attach an ephemeral debug container to a pod (distroless-friendly).
   *  Returns the debug container's name; exec into it afterwards. */
  async debugPod(namespace: string, name: string): Promise<string> {
    await this.ensure()
    const core = this.client(this.mod.CoreV1Api)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pod = (await core.readNamespacedPod({ name, namespace })) as any
    const target = pod?.spec?.containers?.[0]?.name as string | undefined
    const dbgName = `debug-${Math.random().toString(36).slice(2, 6)}`
    const ephemeral = {
      name: dbgName,
      image: 'busybox:1.36',
      command: ['sleep', '3600'],
      stdin: true,
      tty: false,
      targetContainerName: target
    }
    pod.spec.ephemeralContainers = [...(pod.spec.ephemeralContainers ?? []), ephemeral]
    await core.replaceNamespacedPodEphemeralcontainers({ name, namespace, body: pod })

    // wait until the runtime actually starts it
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (await core.readNamespacedPod({ name, namespace })) as any
      const st = (p?.status?.ephemeralContainerStatuses ?? []).find(
        (s: { name?: string }) => s.name === dbgName
      )
      if (st?.state?.running) return dbgName
      if (st?.state?.terminated) throw new Error(`debug container exited: ${st.state.terminated.reason ?? ''}`)
    }
    throw new Error('debug container did not start within 20s')
  }

  async triggerCronJob(name: string, namespace: string): Promise<void> {
    await this.ensure()
    const batch = this.client(this.mod.BatchV1Api)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cj = (await batch.readNamespacedCronJob({ name, namespace })) as any
    const template = cj?.spec?.jobTemplate?.spec
    if (!template) throw new Error('CronJob has no jobTemplate.')
    const suffix = Math.random().toString(36).slice(2, 8)
    await batch.createNamespacedJob({
      namespace,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: `${name}-manual-${suffix}`.slice(0, 63),
          namespace,
          annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' }
        },
        spec: template
      } as any
    })
  }

  /** Recreate a Job from an existing one's spec (strip selector/status/controller labels). */
  async rerunJob(name: string, namespace: string): Promise<void> {
    await this.ensure()
    const batch = this.client(this.mod.BatchV1Api)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job = (await batch.readNamespacedJob({ name, namespace })) as any
    const spec = JSON.parse(JSON.stringify(job?.spec ?? {}))
    delete spec.selector // let the controller generate a fresh selector
    if (spec.template?.metadata?.labels) {
      delete spec.template.metadata.labels['controller-uid']
      delete spec.template.metadata.labels['batch.kubernetes.io/controller-uid']
      delete spec.template.metadata.labels['job-name']
      delete spec.template.metadata.labels['batch.kubernetes.io/job-name']
    }
    const suffix = Math.random().toString(36).slice(2, 8)
    await batch.createNamespacedJob({
      namespace,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: `${name}-rerun-${suffix}`.slice(0, 63), namespace },
        spec
      } as any
    })
  }

  // ---------------- watch ----------------

  async createWatch(key: string, onEvent: WatchCallback): Promise<WatchSession | null> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def || def.api === 'helm' || !def.watchPath) return null
    const session = new WatchSession(
      () => new this.mod.Watch(this.impersonatedKc()),
      def.watchPath,
      def.kind,
      def.apiVersion,
      onEvent
    )
    session.start()
    return session
  }

  async createWatchCustom(ref: CustomRef, onEvent: WatchCallback): Promise<WatchSession> {
    await this.ensure()
    const path = `/apis/${ref.group}/${ref.version}/${ref.plural}`
    const apiVersion = `${ref.group}/${ref.version}`
    const session = new WatchSession(() => new this.mod.Watch(this.impersonatedKc()), path, '', apiVersion, onEvent)
    session.start()
    return session
  }

  // ---------------- logs ----------------

  /** Bounded, non-following log read (AI assistant tool). */
  async podLogs(
    namespace: string,
    pod: string,
    container: string | undefined,
    tailLines: number,
    previous = false
  ): Promise<string> {
    await this.ensure()
    const log = new this.mod.Log(this.impersonatedKc())
    const MAX = 256 * 1024
    let out = ''
    const stream = sink((chunk) => {
      if (out.length < MAX) out += chunk
    })
    const done = new Promise<void>((resolve) => stream.on('finish', resolve))
    const controller = await log.log(namespace, pod, container ?? '', stream, {
      follow: false,
      tailLines: Math.max(1, Math.min(tailLines, 2000)),
      timestamps: false,
      previous,
      pretty: false
    })
    // follow:false streams the snapshot and ends; the timeout is a backstop.
    await Promise.race([done, new Promise((r) => setTimeout(r, 20000))])
    try {
      controller.abort()
    } catch {
      /* already ended */
    }
    return out.length >= MAX ? out.slice(0, MAX) + '\n...truncated' : out
  }

  async startLogs(
    namespace: string,
    pod: string,
    query: LogQuery,
    onData: (s: string) => void,
    onClose: (err?: string) => void
  ): Promise<StreamHandle> {
    await this.ensure()
    const log = new this.mod.Log(this.impersonatedKc())
    const stream = sink(onData)
    stream.on('finish', () => onClose())
    const controller = await log.log(namespace, pod, query.container ?? '', stream, {
      follow: query.follow ?? true,
      // tailLines <= 0 means "from the start" - omit the option entirely.
      ...(query.tailLines === undefined || query.tailLines > 0
        ? { tailLines: query.tailLines ?? 500 }
        : {}),
      ...(query.sinceSeconds && query.sinceSeconds > 0 ? { sinceSeconds: query.sinceSeconds } : {}),
      timestamps: query.timestamps ?? false,
      previous: query.previous ?? false,
      pretty: false
    })
    return {
      stop: () => {
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---------------- exec / terminal ----------------

  async startExec(
    namespace: string,
    pod: string,
    container: string,
    command: string[],
    onData: (s: string) => void,
    onClose: (err?: string) => void
  ): Promise<ExecHandle> {
    await this.ensure()
    const exec = new this.mod.Exec(this.impersonatedKc())
    const stdin = new PassThrough()
    stdin.on('error', () => {})
    const out = sink(onData)
    const ws = await exec.exec(
      namespace,
      pod,
      container,
      command,
      out,
      out,
      stdin,
      true,
      (status) => {
        if (status.status === 'Failure') onClose(status.message)
      }
    )
    ws.on('close', () => onClose())
    ws.on('error', (e: unknown) => onClose(errMsg(e)))
    return {
      input: (data: string) => {
        try {
          stdin.write(data)
        } catch {
          /* ignore */
        }
      },
      resize: (cols: number, rows: number) => {
        try {
          // k8s v4 exec subprotocol: channel 4 carries terminal resize JSON.
          const payload = Buffer.from(JSON.stringify({ Width: cols, Height: rows }))
          ws.send(Buffer.concat([Buffer.from([4]), payload]))
        } catch {
          /* ignore */
        }
      },
      stop: () => {
        try {
          stdin.end()
          ws.close()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Run a short non-interactive command and capture its output - the basis of
   * the pod file browser (ls / base64). Output is capped so `cat` on a huge
   * file cannot balloon the main process; the stream is torn down at the cap.
   *
   * SECURITY: the command is NOT caller-controlled. This method is reachable
   * from the renderer (IPC) and, in-cluster, from any authenticated session
   * (`podExecCapture` over RPC). Accepting an arbitrary argv there would hand
   * every such caller remote command execution in any pod they can name, so the
   * argv is checked against the exact shapes the file browser issues. Enforcing
   * it here rather than in each transport means a new caller cannot forget it.
   */
  async execCapture(
    namespace: string,
    pod: string,
    container: string,
    command: string[],
    opts?: { stdin?: string; maxBytes?: number; timeoutMs?: number }
  ): Promise<{ out: string; err: string; code: number | null }> {
    assertAllowedCapture(command)
    await this.ensure()
    const max = opts?.maxBytes ?? 8 * 1024 * 1024
    const exec = new this.mod.Exec(this.impersonatedKc())
    let out = ''
    let err = ''
    let code: number | null = null
    let done!: () => void
    const finished = new Promise<void>((r) => (done = r))

    const collect = (into: 'out' | 'err'): Writable =>
      new Writable({
        write: (chunk, _enc, cb) => {
          if (into === 'out') out += chunk.toString('utf8')
          else err += chunk.toString('utf8')
          if (out.length + err.length > max) done() // cap hit - stop collecting
          cb()
        }
      }).on('error', () => {})

    const stdin = opts?.stdin !== undefined ? new PassThrough() : null
    stdin?.on('error', () => {})

    const ws = await exec.exec(
      namespace,
      pod,
      container,
      command,
      collect('out'),
      collect('err'),
      stdin,
      false, // no tty - keeps stdout/stderr separate and binary-safe for base64
      (status) => {
        code = status.status === 'Success' ? 0 : 1
        // exit code detail rides status.details.causes[{reason:ExitCode}]
        const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode')
        if (cause?.message) code = Number(cause.message) || 1
        // On failures with silent streams (kubelet unreachable, no such
        // container), the status message is the only diagnostic - surface it.
        if (status.status === 'Failure' && status.message && !err) err = status.message
      }
    )
    ws.on('close', () => done())
    ws.on('error', () => done())
    if (stdin && opts?.stdin !== undefined) {
      stdin.write(opts.stdin)
      stdin.end()
    }
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      done()
    }, opts?.timeoutMs ?? 30000)
    await finished
    clearTimeout(timer)
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    return { out: out.slice(0, max), err: err.slice(0, 64 * 1024), code }
  }

  // ---------------- cross-context reads ----------------

  /**
   * Read one object from ANOTHER kubeconfig context without switching to it -
   * powers "compare across clusters". Throwaway client per call; never mutates
   * this.kc. Desktop-only by nature (the in-cluster server has one context).
   */
  async getResourceInContext(context: string, key: string, name: string, namespace?: string): Promise<K8sObject | null> {
    await this.ensure()
    const def = getResourceDef(key)
    if (!def || def.api === 'helm') return null
    const kc = new this.mod.KubeConfig()
    kc.loadFromDefault()
    if (!kc.getContexts().some((c) => c.name === context)) throw new Error(`Unknown context: ${context}`)
    kc.setCurrentContext(context)
    try {
      const objApi = this.mod.KubernetesObjectApi.makeApiClient(kc)
      const obj = await objApi.read({
        apiVersion: def.apiVersion || 'v1',
        kind: def.kind,
        metadata: { name, namespace: namespace || undefined }
      })
      return obj as K8sObject
    } catch (e) {
      throw new Error(errMsg(e))
    }
  }

  // ---------------- port forwarding ----------------

  /** Local TCP server that pipes each connection to pod:targetPort via the k8s API. */
  private async createForwardServer(
    namespace: string,
    pod: string,
    targetPort: number,
    localPort: number | undefined
  ): Promise<{ server: net.Server; actualLocal: number; sockets: Set<net.Socket> }> {
    const pf = new this.mod.PortForward(this.impersonatedKc())
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      pf.portForward(namespace, pod, [targetPort], socket, socket, socket).catch(() => socket.destroy())
    })

    const listenOn = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onErr = (e: Error): void => {
          server.removeListener('error', onErr)
          reject(e)
        }
        server.once('error', onErr)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onErr)
          const addr = server.address()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        })
      })

    let actualLocal: number
    try {
      actualLocal = await listenOn(localPort ?? 0)
    } catch {
      actualLocal = await listenOn(0)
    }
    return { server, actualLocal, sockets }
  }

  async startPortForward(
    id: string,
    namespace: string,
    pod: string,
    remotePort: number,
    localPort: number | undefined,
    onError: (info: PortForwardInfo) => void
  ): Promise<PfHandle> {
    await this.ensure()
    const { server, actualLocal, sockets } = await this.createForwardServer(namespace, pod, remotePort, localPort)
    const info: PortForwardInfo = { id, namespace, pod, remotePort, localPort: actualLocal }
    server.on('error', (e) => onError({ ...info, error: errMsg(e) }))
    return {
      info,
      stop: () => {
        for (const s of sockets) s.destroy()
        server.close()
      }
    }
  }

  /**
   * Forward a Service port: resolve the service's selector to a backing pod and
   * map the service port to the pod's targetPort (like `kubectl port-forward svc/...`).
   */
  async startServicePortForward(
    id: string,
    namespace: string,
    service: string,
    servicePort: number,
    localPort: number | undefined,
    onError: (info: PortForwardInfo) => void
  ): Promise<PfHandle> {
    await this.ensure()
    const core = this.client(this.mod.CoreV1Api)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = (await core.readNamespacedService({ name: service, namespace })) as any
    const selector = (svc?.spec?.selector ?? {}) as Record<string, string>
    if (!Object.keys(selector).length) throw new Error(`Service "${service}" has no pod selector to forward to.`)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const portsSpec: any[] = svc?.spec?.ports ?? []
    const portEntry = portsSpec.find((p) => p.port === servicePort) ?? portsSpec[0]
    let targetPort: number | string = portEntry?.targetPort ?? servicePort

    const labelSelector = Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pods = (await core.listNamespacedPod({ namespace, labelSelector })) as any
    const items: any[] = pods?.items ?? []
    const pod = items.find((p) => p?.status?.phase === 'Running') ?? items[0]
    if (!pod) throw new Error(`No pods backing service "${service}".`)
    const podName = pod.metadata?.name as string

    // Resolve a named targetPort against the chosen pod's container ports.
    if (typeof targetPort === 'string') {
      let resolved: number | undefined
      for (const c of pod.spec?.containers ?? [])
        for (const cp of c.ports ?? []) if (cp.name === targetPort) resolved = cp.containerPort
      targetPort = resolved ?? servicePort
    }

    const { server, actualLocal, sockets } = await this.createForwardServer(
      namespace,
      podName,
      targetPort as number,
      localPort
    )
    const info: PortForwardInfo = { id, namespace, pod: podName, service, remotePort: servicePort, localPort: actualLocal }
    server.on('error', (e) => onError({ ...info, error: errMsg(e) }))
    return {
      info,
      stop: () => {
        for (const s of sockets) s.destroy()
        server.close()
      }
    }
  }
}
