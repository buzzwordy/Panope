import yaml from 'js-yaml'
import { CATALOG, getResourceDef } from '../../shared/catalog'
import type { KubernetesService } from '../kube/client'
import type { MutationResult } from '../../shared/types'
import { redactForModel, redactValuesYaml } from './redact'
import type { ChatTool, AiToolCallReq } from './provider'

/**
 * The tool surface the model sees. Reads run immediately through the user's
 * own (impersonated) identity, so the model cannot see anything the user
 * cannot. Mutations never run here - the session holds them for an explicit
 * click in the UI, then executes through the same read-only gate and audit
 * trail as a human action.
 */

export interface ToolDeps {
  svc: KubernetesService
  isReadOnly: () => boolean
  audit: (method: string, target: string, ok: boolean, error?: string) => void
}

const MAX_RESULT_CHARS = 60_000
const MAX_LIST_ITEMS = 100

const str = { type: 'string' } as const
const num = { type: 'number' } as const

const key = {
  type: 'string',
  description: 'resource key from list_kinds, e.g. "pods", "deployments", "secrets"'
} as const

export const READ_TOOLS: ChatTool[] = [
  {
    name: 'list_kinds',
    description: 'List every resource kind this cluster/app knows, with its key. Call this before guessing a key.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'cluster_info',
    description: 'Current context name, Kubernetes version, API server and the list of namespaces.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'list_resources',
    description:
      'List objects of a kind: names, namespaces, creation time. Optionally filter to one namespace. Secret values are never included.',
    parameters: {
      type: 'object',
      properties: { key, namespace: str },
      required: ['key']
    }
  },
  {
    name: 'get_resource',
    description: 'Fetch one object in full (spec + status). Secret data values are redacted to size markers.',
    parameters: {
      type: 'object',
      properties: { key, name: str, namespace: str },
      required: ['key', 'name']
    }
  },
  {
    name: 'get_events',
    description: 'Kubernetes events involving one named object. Requires the object name.',
    parameters: {
      type: 'object',
      properties: { name: str, namespace: str, kind: str },
      required: ['name']
    }
  },
  {
    name: 'pod_logs',
    description: 'Read the last N lines of a container log. Set previous=true for the crashed instance of a restarting pod.',
    parameters: {
      type: 'object',
      properties: {
        namespace: str,
        pod: str,
        container: str,
        tailLines: { ...num, description: 'default 200, max 2000' },
        previous: { type: 'boolean' }
      },
      required: ['namespace', 'pod']
    }
  },
  {
    name: 'get_metrics',
    description: 'Live CPU/memory usage from metrics-server for pods or nodes.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['pods', 'nodes'] } },
      required: ['kind']
    }
  },
  {
    name: 'can_i',
    description: 'Ask the RBAC authorizer whether the current user may do something. Use before proposing an action.',
    parameters: {
      type: 'object',
      properties: {
        verb: { ...str, description: 'get, list, create, update, patch, delete...' },
        resource: { ...str, description: 'plural resource, e.g. "deployments"' },
        group: { ...str, description: 'API group, "" for core' },
        namespace: str
      },
      required: ['verb', 'resource']
    }
  },
  {
    name: 'who_am_i',
    description: 'The identity every call runs as (user and groups).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'helm_history',
    description: 'Revision history of a Helm release.',
    parameters: { type: 'object', properties: { name: str, namespace: str }, required: ['name', 'namespace'] }
  },
  {
    name: 'helm_get',
    description: 'Values, manifest or notes of an installed Helm release. Credential-like values are masked.',
    parameters: {
      type: 'object',
      properties: {
        name: str,
        namespace: str,
        what: { type: 'string', enum: ['values', 'manifest', 'notes'] }
      },
      required: ['name', 'namespace', 'what']
    }
  }
]

export const MUTATION_TOOLS: ChatTool[] = [
  {
    name: 'scale_resource',
    description: 'Scale a deployment/statefulset/replicaset. Requires user approval.',
    parameters: {
      type: 'object',
      properties: { key, name: str, namespace: str, replicas: num },
      required: ['key', 'name', 'replicas']
    }
  },
  {
    name: 'restart_resource',
    description: 'Rolling restart of a workload (or delete of a bare pod). Requires user approval.',
    parameters: { type: 'object', properties: { key, name: str, namespace: str }, required: ['key', 'name'] }
  },
  {
    name: 'delete_resource',
    description: 'Delete one object. Requires user approval.',
    parameters: { type: 'object', properties: { key, name: str, namespace: str }, required: ['key', 'name'] }
  },
  {
    name: 'apply_yaml',
    description: 'Server-side apply of a YAML manifest (create or update). Requires user approval.',
    parameters: { type: 'object', properties: { yaml: str }, required: ['yaml'] }
  },
  {
    name: 'patch_resource',
    description:
      'Strategic/merge patch on one object, e.g. {"metadata":{"finalizers":[]}} to clear stuck finalizers, or {"spec":{"unschedulable":true}} to cordon a node. Requires user approval.',
    parameters: {
      type: 'object',
      properties: { key, name: str, namespace: str, patch: { type: 'object', description: 'the merge patch body' } },
      required: ['key', 'name', 'patch']
    }
  },
  {
    name: 'rerun_job',
    description: 'Create a fresh Job copied from an existing (completed or failed) Job. Requires user approval.',
    parameters: { type: 'object', properties: { name: str, namespace: str }, required: ['name', 'namespace'] }
  },
  {
    name: 'drain_node',
    description: 'Cordon a node and evict its pods, like kubectl drain. Disruptive. Requires user approval.',
    parameters: { type: 'object', properties: { name: str }, required: ['name'] }
  },
  {
    name: 'helm_rollback',
    description: 'Roll a Helm release back to a given revision (see helm_history). Requires user approval.',
    parameters: {
      type: 'object',
      properties: { name: str, namespace: str, revision: num },
      required: ['name', 'namespace', 'revision']
    }
  },
  {
    name: 'trigger_cronjob',
    description: 'Create a Job from a CronJob right now. Requires user approval.',
    parameters: { type: 'object', properties: { name: str, namespace: str }, required: ['name', 'namespace'] }
  },
  {
    name: 'rollback_deployment',
    description: 'Roll a deployment back to its previous ReplicaSet. Requires user approval.',
    parameters: { type: 'object', properties: { name: str, namespace: str }, required: ['name', 'namespace'] }
  }
]

export const ALL_TOOLS: ChatTool[] = [...READ_TOOLS, ...MUTATION_TOOLS]

const MUTATIONS = new Set(MUTATION_TOOLS.map((t) => t.name))

export function isMutation(name: string): boolean {
  return MUTATIONS.has(name)
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const nsName = (ns: unknown, name: unknown): string => (s(ns) ? `${s(ns)}/${s(name)}` : s(name))

/** One line for the UI chip / confirmation card. */
export function callSummary(call: AiToolCallReq): string {
  const a = call.args
  switch (call.name) {
    case 'list_resources':
      return `list ${s(a.key)}${s(a.namespace) ? ` in ${s(a.namespace)}` : ''}`
    case 'get_resource':
      return `get ${s(a.key)} ${nsName(a.namespace, a.name)}`
    case 'get_events':
      return `events for ${nsName(a.namespace, a.name) || 'namespace'}`
    case 'pod_logs':
      return `logs ${nsName(a.namespace, a.pod)}${s(a.container) ? ` (${s(a.container)})` : ''}`
    case 'get_metrics':
      return `metrics: ${s(a.kind)}`
    case 'can_i':
      return `can I ${s(a.verb)} ${s(a.resource)}${s(a.namespace) ? ` in ${s(a.namespace)}` : ''}?`
    case 'helm_history':
      return `helm history ${nsName(a.namespace, a.name)}`
    case 'helm_get':
      return `helm ${s(a.what)} ${nsName(a.namespace, a.name)}`
    case 'scale_resource':
      return `scale ${s(a.key)} ${nsName(a.namespace, a.name)} to ${Number(a.replicas)}`
    case 'restart_resource':
      return `restart ${s(a.key)} ${nsName(a.namespace, a.name)}`
    case 'delete_resource':
      return `delete ${s(a.key)} ${nsName(a.namespace, a.name)}`
    case 'apply_yaml':
      return `apply ${String(a.yaml ?? '').split('\n').length} lines of YAML`
    case 'patch_resource':
      return `patch ${s(a.key)} ${nsName(a.namespace, a.name)}`
    case 'rerun_job':
      return `re-run job ${nsName(a.namespace, a.name)}`
    case 'drain_node':
      return `drain node ${s(a.name)}`
    case 'helm_rollback':
      return `helm rollback ${nsName(a.namespace, a.name)} to revision ${Number(a.revision)}`
    case 'trigger_cronjob':
      return `trigger cronjob ${nsName(a.namespace, a.name)}`
    case 'rollback_deployment':
      return `rollback deployment ${nsName(a.namespace, a.name)}`
    default:
      return call.name
  }
}

function cap(v: unknown): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n...truncated' : text
}

/** Read tools only; mutations are executed by the session after approval. */
export async function runReadTool(call: AiToolCallReq, deps: ToolDeps): Promise<string> {
  const { svc } = deps
  const a = call.args
  try {
    switch (call.name) {
      case 'list_kinds':
        return cap(CATALOG.filter((d) => !d.unsupported).map((d) => ({ key: d.key, kind: d.kind, namespaced: d.namespaced })))
      case 'cluster_info': {
        const [info, namespaces] = await Promise.all([svc.getClusterInfo(), svc.getNamespaces()])
        return cap({ ...info, namespaces })
      }
      case 'list_resources': {
        const def = getResourceDef(s(a.key))
        if (!def) return `Error: unknown key "${s(a.key)}". Call list_kinds.`
        const res = await svc.listResource(s(a.key))
        if (res.error) return `Error: ${res.error}`
        const ns = s(a.namespace)
        const items = res.items.filter((i) => !ns || i.metadata?.namespace === ns)
        const trimmed = items.slice(0, MAX_LIST_ITEMS).map((i) => ({
          name: i.metadata?.name,
          namespace: i.metadata?.namespace,
          created: i.metadata?.creationTimestamp,
          status: (i as { status?: { phase?: string } }).status?.phase
        }))
        return cap({
          total: items.length,
          ...(items.length > MAX_LIST_ITEMS ? { note: `showing first ${MAX_LIST_ITEMS}` } : {}),
          items: trimmed
        })
      }
      case 'get_resource': {
        const obj = await svc.getResource(s(a.key), s(a.name), s(a.namespace) || undefined)
        if (!obj) return 'Error: not found'
        return cap(redactForModel(obj, s(a.key) === 'secrets'))
      }
      case 'get_events': {
        const events = await svc.getEvents(s(a.name), s(a.namespace) || undefined, s(a.kind) || undefined)
        return cap(
          events.map((e) => {
            const ev = e as Record<string, unknown>
            return {
              type: ev.type,
              reason: ev.reason,
              message: ev.message,
              count: ev.count,
              last: ev.lastTimestamp ?? ev.eventTime
            }
          })
        )
      }
      case 'pod_logs':
        return cap(
          await svc.podLogs(
            s(a.namespace),
            s(a.pod),
            s(a.container) || undefined,
            Number(a.tailLines) || 200,
            a.previous === true
          )
        )
      case 'get_metrics':
        return cap(await svc.getMetrics(a.kind === 'nodes' ? 'nodes' : 'pods'))
      case 'can_i': {
        // A missing group means "core", which yields false denials for apps/
        // batch resources; resolve it from the catalog when we know the kind.
        let group = s(a.group) || undefined
        if (group === undefined) {
          const def = CATALOG.find((d) => d.key === s(a.resource))
          if (def) group = def.group || undefined
        }
        const results = await svc.canI([
          {
            verb: s(a.verb),
            resource: s(a.resource),
            group,
            namespace: s(a.namespace) || undefined
          }
        ])
        return cap(results)
      }
      case 'who_am_i':
        return cap(await svc.whoAmI())
      case 'helm_history':
        return cap(await svc.helmHistory(s(a.name), s(a.namespace)))
      case 'helm_get': {
        const what = a.what as 'values' | 'manifest' | 'notes'
        const out = await svc.helmGet(s(a.name), s(a.namespace), what)
        if (what === 'notes') return cap(out)
        // A rendered manifest contains whole objects, Secrets among them, so the
        // key-name heuristic is not enough - run each doc through the same
        // Secret-aware redactor get_resource uses. values files get the heuristic.
        if (what === 'manifest') {
          try {
            const docs = (yaml.loadAll(out) as unknown[])
              .filter((d) => d && typeof d === 'object')
              .map((d) => redactForModel(d, false))
            return cap(docs.map((d) => yaml.dump(d)).join('---\n'))
          } catch {
            // unparseable manifest: fall back to the heuristic rather than raw
            return cap(redactValuesYaml(out))
          }
        }
        return cap(redactValuesYaml(out))
      }
      default:
        return `Error: unknown tool "${call.name}"`
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

const READONLY_MSG = 'Panope is in read-only mode (unlock it in Preferences or the top bar).'

/** Runs an approved mutation through the same gate and audit trail as a click. */
export async function runMutation(call: AiToolCallReq, deps: ToolDeps): Promise<MutationResult> {
  if (deps.isReadOnly()) return { ok: false, error: READONLY_MSG }
  const { svc } = deps
  const a = call.args
  const target = (): string => callSummary(call)
  const exec = (): Promise<void> => {
    switch (call.name) {
      case 'scale_resource':
        return svc.scaleResource(s(a.key), s(a.name), s(a.namespace) || undefined, Number(a.replicas))
      case 'restart_resource':
        return svc.restartResource(s(a.key), s(a.name), s(a.namespace) || undefined)
      case 'delete_resource':
        return svc.deleteResource(s(a.key), s(a.name), s(a.namespace) || undefined)
      case 'apply_yaml':
        return svc.applyYaml(s(a.yaml))
      case 'patch_resource': {
        const p = (a.patch && typeof a.patch === 'object' ? a.patch : {}) as Record<string, unknown>
        // client.ts spreads the patch over its own metadata, so a patch that
        // carries metadata must keep name/namespace or the request loses them
        const meta = (p.metadata && typeof p.metadata === 'object' ? p.metadata : undefined) as
          | Record<string, unknown>
          | undefined
        const patch = meta
          ? { ...p, metadata: { name: s(a.name), ...(s(a.namespace) ? { namespace: s(a.namespace) } : {}), ...meta } }
          : p
        return svc.patchMerge(s(a.key), s(a.name), s(a.namespace) || undefined, patch)
      }
      case 'rerun_job':
        return svc.rerunJob(s(a.name), s(a.namespace))
      case 'drain_node':
        return svc.drainNode(s(a.name))
      case 'helm_rollback':
        return svc.helmRollback(s(a.name), s(a.namespace), Number(a.revision))
      case 'trigger_cronjob':
        return svc.triggerCronJob(s(a.name), s(a.namespace))
      case 'rollback_deployment':
        return svc.rollbackDeployment(s(a.name), s(a.namespace))
      default:
        return Promise.reject(new Error(`unknown mutation "${call.name}"`))
    }
  }
  try {
    await exec()
    deps.audit(`ai:${call.name}`, target(), true)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    deps.audit(`ai:${call.name}`, target(), false, msg)
    return { ok: false, error: msg }
  }
}
