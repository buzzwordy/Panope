import type { Session } from './session'
import type { AccessCheck, AccessSubject, CustomRef, HelmChartSpec, LogQuery, ApplyOptions } from '../shared/types'
import { namespaceAllowed, type Feature } from './authz'
import { recordAudit, auditEntries, describeTarget } from './audit'

/**
 * Maps the `PanopeApi` surface onto plain request/response calls.
 *
 * The desktop app reaches these methods over Electron IPC; the browser reaches
 * them over HTTP POST /rpc. Both end up here, so the two transports can never
 * drift apart in behaviour.
 *
 * Streaming methods (watch/logs/exec/port-forward) are NOT here - they live in
 * the WebSocket layer because they push.
 */

type Handler = (s: Session, args: unknown[]) => unknown

/** Own version, for the About dialog. package.json ships in the runtime image
 *  next to the compiled server, so read it rather than duplicating the number
 *  into an env var that can drift from the build. */
const SERVER_VERSION = ((): string => {
  if (process.env.PANOPE_VERSION) return process.env.PANOPE_VERSION
  for (const p of ['../../package.json', '../../../package.json']) {
    try {
      const { version } = require(p) as { version?: string }
      if (version) return version
    } catch {
      /* try the next candidate */
    }
  }
  return 'unknown'
})()

/** Mutating calls, blocked when the deployment is running read-only. */
const MUTATIONS = new Set([
  'applyYaml',
  'deleteResource',
  'deleteCustom',
  'scaleResource',
  'restartResource',
  'patchMerge',
  'drainNode',
  'nodeShell',
  'debugPod',
  'rollbackDeployment',
  'triggerCronJob',
  'rerunJob',
  'helmUninstall',
  'helmRollback',
  'helmInstall',
  'helmUpgrade',
  // Exec in a container is write-capable access however the output is used, so
  // both the capture and the write honour read-only - matching the interactive
  // terminal, and the promise README/chart values make about read-only mode.
  'podExecCapture',
  'podWriteFile',
  'argoSync',
  'argoRefresh'
])

/** Calls a shared web deployment must never expose, whatever RBAC says. */
const DESKTOP_ONLY = new Set(['setContext', 'fleetSummary', 'setReadOnly', 'getResourceInContext'])

const ok = (v: unknown): { ok: true } | unknown => v

export const RPC: Record<string, Handler> = {
  // ---- read ----
  getClusterInfo: (s) => s.svc.getClusterInfo(),
  getNamespaces: (s) => s.svc.getNamespaces(),
  listContexts: (s) => s.svc.listContexts(),
  ping: (s) => s.svc.ping().then(() => null),
  listResource: (s, [key]) => s.svc.listResource(key as string),
  countResource: (s, [key]) => s.svc.countResource(key as string),
  getResource: (s, [key, name, ns]) => s.svc.getResource(key as string, name as string, ns as string | undefined),
  getMetrics: (s, [kind]) => s.svc.getMetrics(kind as 'pods' | 'nodes'),
  getEvents: (s, [name, ns, kind]) =>
    s.svc.getEvents(name as string, ns as string | undefined, kind as string | undefined),
  openApiSchemas: (s, [apiVersion]) => s.svc.openApiSchemas(apiVersion as string),
  listCRDs: (s) => s.svc.listCRDs(),
  listCustom: (s, [ref]) => s.svc.listCustom(ref as CustomRef),
  listHelmRepos: (s) => s.svc.listHelmRepos(),
  getAppInfo: () => ({
    name: 'Panope',
    version: SERVER_VERSION,
    mode: 'in-cluster' as const,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`
  }),
  helmHistory: (s, [name, ns]) => s.svc.helmHistory(name as string, ns as string),
  helmGet: (s, [name, ns, what]) =>
    s.svc.helmGet(name as string, ns as string, what as 'values' | 'manifest' | 'notes'),

  // ---- write ----
  applyYaml: (s, [text, opts]) => s.svc.applyYaml(text as string, opts as ApplyOptions | undefined).then(() => ok({ ok: true })),
  deleteResource: (s, [key, name, ns]) =>
    s.svc.deleteResource(key as string, name as string, ns as string | undefined),
  deleteCustom: (s, [ref, name, ns]) =>
    s.svc.deleteCustom(ref as CustomRef, name as string, ns as string | undefined),
  scaleResource: (s, [key, name, ns, replicas]) =>
    s.svc.scaleResource(key as string, name as string, ns as string | undefined, replicas as number),
  restartResource: (s, [key, name, ns]) =>
    s.svc.restartResource(key as string, name as string, ns as string | undefined),
  patchMerge: (s, [key, name, ns, patch]) =>
    s.svc.patchMerge(key as string, name as string, ns as string | undefined, patch as object),
  drainNode: (s, [name]) => s.svc.drainNode(name as string),
  rollbackDeployment: (s, [name, ns]) => s.svc.rollbackDeployment(name as string, ns as string),
  triggerCronJob: (s, [name, ns]) => s.svc.triggerCronJob(name as string, ns as string),
  rerunJob: (s, [name, ns]) => s.svc.rerunJob(name as string, ns as string),
  helmUninstall: (s, [name, ns]) => s.svc.helmUninstall(name as string, ns as string),
  helmRollback: (s, [name, ns, rev]) => s.svc.helmRollback(name as string, ns as string, rev as number),
  argoSync: (s, [ns, name]) => s.svc.argoSync(ns as string, name as string),
  argoRefresh: (s, [ns, name]) => s.svc.argoRefresh(ns as string, name as string),
  nodeShell: (s, [node]) => s.svc.nodeShell(node as string),
  debugPod: (s, [ns, name]) => s.svc.debugPod(ns as string, name as string),

  // ---- access / RBAC introspection ----
  // Self-checks run under the session's impersonated identity, so "can I?"
  // means the logged-in user, not the ServiceAccount.
  canI: (s, [checks, as]) => s.svc.canI(checks as AccessCheck[], as as AccessSubject | undefined),
  whoAmI: (s) =>
    s.identity.user
      ? { user: s.identity.user, groups: s.identity.groups, source: 'session', role: s.policy.role }
      : s.svc.whoAmI(),

  // ---- audit trail ----
  // Your own actions, unless your role is privileged (then: the deployment's).
  auditLog: (s) => auditEntries(s.policy.privileged ? undefined : s.identity.user),

  // ---- pod files ----
  podExecCapture: (s, [ns, pod, container, command]) =>
    s.svc.execCapture(ns as string, pod as string, container as string, command as string[]),
  podWriteFile: (s, [ns, pod, container, path, b64]) =>
    s.svc
      .execCapture(ns as string, pod as string, container as string, ['sh', '-c', 'base64 -d > "$0"', path as string], {
        stdin: b64 as string,
        timeoutMs: 60000
      })
      .then((r) => {
        if (r.code !== 0) throw new Error(r.err || `write failed (exit ${r.code})`)
        return { ok: true }
      }),

  // ---- helm install / upgrade ----
  helmInstall: (s, [spec]) => s.svc.helmInstall(spec as HelmChartSpec),
  helmUpgrade: (s, [spec]) => s.svc.helmUpgrade(spec as HelmChartSpec),
  helmShowValues: (s, [chart, version]) => s.svc.helmShowValues(chart as string, version as string | undefined)
}

export interface RpcPolicy {
  readOnly: boolean
  /** privileged actions disabled by chart values (node shell / debug pods) */
  allowPrivileged: boolean
}

/** Which app-level feature each method needs; unlisted = plain read. */
const FEATURE_OF: Record<string, Feature> = {
  applyYaml: 'apply',
  deleteResource: 'delete',
  deleteCustom: 'delete',
  scaleResource: 'scale',
  restartResource: 'apply',
  patchMerge: 'apply',
  drainNode: 'apply',
  rollbackDeployment: 'apply',
  triggerCronJob: 'apply',
  rerunJob: 'apply',
  helmUninstall: 'helm',
  helmRollback: 'helm',
  helmHistory: 'helm',
  helmGet: 'helm',
  helmInstall: 'helm',
  helmUpgrade: 'helm',
  helmShowValues: 'helm',
  argoSync: 'argo',
  argoRefresh: 'argo',
  nodeShell: 'nodeShell',
  debugPod: 'debugContainer',
  getEvents: 'events',
  // the file browser is exec by other means
  podExecCapture: 'exec',
  podWriteFile: 'exec'
}

/** Namespace argument position per method, for namespace-scoped policies. */
const NS_ARG: Record<string, number> = {
  getResource: 2,
  deleteResource: 2,
  deleteCustom: 2,
  scaleResource: 2,
  restartResource: 2,
  patchMerge: 2,
  getEvents: 1,
  rollbackDeployment: 1,
  triggerCronJob: 1,
  rerunJob: 1,
  helmUninstall: 1,
  helmRollback: 1,
  helmGet: 1,
  argoSync: 0,
  argoRefresh: 0,
  debugPod: 0,
  podExecCapture: 0,
  podWriteFile: 0
}

/** Namespace nested inside an object argument (helm specs). */
function nestedNamespace(method: string, args: unknown[]): string | undefined {
  if (method === 'helmInstall' || method === 'helmUpgrade') {
    const spec = args[0] as { namespace?: unknown } | undefined
    return typeof spec?.namespace === 'string' ? spec.namespace : undefined
  }
  return undefined
}

export async function callRpc(
  session: Session,
  method: string,
  args: unknown[],
  policy: RpcPolicy
): Promise<{ result?: unknown; error?: string }> {
  if (DESKTOP_ONLY.has(method)) return { error: `${method} is not available in the in-cluster deployment.` }
  // Own-property lookup only: `RPC["constructor"]` / `"__proto__"` would
  // otherwise resolve to an Object.prototype member and get invoked, which
  // could return internal objects (and with them the ServiceAccount token).
  if (!Object.prototype.hasOwnProperty.call(RPC, method)) return { error: `Unknown method: ${method}` }
  const handler = RPC[method]
  if (typeof handler !== 'function') return { error: `Unknown method: ${method}` }

  const deploymentReadOnly = policy.readOnly || session.policy.readOnly
  if (deploymentReadOnly && MUTATIONS.has(method)) {
    return { error: 'This Panope deployment is read-only for your role.' }
  }
  if ((method === 'nodeShell' || method === 'debugPod') && !(policy.allowPrivileged && session.policy.privileged)) {
    return { error: `${method} is disabled on this deployment.` }
  }
  // App-level feature gate (guardrail only - RBAC is still the real boundary).
  const needed = FEATURE_OF[method]
  if (needed && !session.policy.features.has(needed)) {
    return { error: `Your role (${session.policy.role}) does not include the "${needed}" feature.` }
  }
  const nsIdx = NS_ARG[method]
  if (nsIdx !== undefined) {
    const ns = args[nsIdx]
    if (typeof ns === 'string' && !namespaceAllowed(ns, session.policy)) {
      return { error: `Your role is scoped to: ${session.policy.namespaces.join(', ')}` }
    }
  }
  const nestedNs = nestedNamespace(method, args)
  if (nestedNs && !namespaceAllowed(nestedNs, session.policy)) {
    return { error: `Your role is scoped to: ${session.policy.namespaces.join(', ')}` }
  }

  // Mutations leave an audit entry either way - success or failure.
  // (dry-run applies change nothing and would only be noise)
  const audit =
    MUTATIONS.has(method) && !(method === 'applyYaml' && (args[1] as ApplyOptions | undefined)?.dryRun)
  try {
    const result = await handler(session, args)
    if (audit) recordAudit(session.identity.user, method, describeTarget(method, args), true)
    return { result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (audit) recordAudit(session.identity.user, method, describeTarget(method, args), false, msg)
    // RBAC denials arrive here - surface them verbatim so the user learns which
    // permission they are missing (the response is already scoped to them).
    return { error: msg }
  }
}

export type { LogQuery }
