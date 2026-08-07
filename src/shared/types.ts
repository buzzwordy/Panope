// Shared type contract between the Electron main process, preload bridge, and renderer.
// Keep this dependency-free so it can be imported from any of the three targets.

/** Minimal shape of every Kubernetes object we render. */
export interface K8sObjectMeta {
  name?: string
  namespace?: string
  uid?: string
  resourceVersion?: string
  creationTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: Array<{ kind: string; name: string; uid: string }>
  deletionTimestamp?: string
}

export interface K8sObject {
  apiVersion?: string
  kind?: string
  metadata?: K8sObjectMeta
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
  // resource-specific top-level fields (data, stringData, subsets, rules, roleRef, subjects, ...)
  [key: string]: unknown
}

export interface ListResult {
  items: K8sObject[]
  resourceVersion?: string
  /** Set when the list failed softly (e.g. 403 / resource not present); items will be empty. */
  error?: string
}

/** A kubeconfig context the user can switch between. */
export interface KubeContextInfo {
  name: string
  cluster?: string
  user?: string
  namespace?: string
  current: boolean
  /** which kubeconfig file this context came from (desktop, multi-file setups) */
  source?: string
}

/** One kubeconfig file feeding the merged view, with its own diagnostics. */
export interface KubeconfigFile {
  path: string
  /** false when the file is gone or unreadable; `error` says why */
  ok: boolean
  /** comes from $KUBECONFIG or ~/.kube/config rather than being user-added */
  isDefault: boolean
  /** context names this file contributed */
  contexts: string[]
  /**
   * Names this file defines that an earlier file already claimed. kubectl's
   * merge rule is first-one-wins, so these are silently inactive - surfacing
   * them is the difference between "my context vanished" and an explanation.
   */
  shadowed: string[]
  error?: string
}

export interface ClusterInfo {
  context: string
  server?: string
  version?: string
  platform?: string
  /** Whether metrics.k8s.io responded (metrics-server present). */
  metricsAvailable: boolean
}

/** A single usage sample keyed by namespace/name (or just name for cluster-scoped). */
export interface MetricSample {
  namespace?: string
  name: string
  /** CPU in millicores. */
  cpu: number
  /** Memory in bytes. */
  memory: number
}

export interface MetricsResult {
  available: boolean
  samples: MetricSample[]
  error?: string
}

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR' | 'BOOKMARK'

export interface WatchEvent {
  subscriptionId: string
  type: WatchEventType
  object?: K8sObject
  error?: string
}

/** Result of a mutating operation. */
export interface MutationResult {
  ok: boolean
  error?: string
}

/** A discovered CustomResourceDefinition, flattened to one served version. */
export interface CrdInfo {
  group: string
  version: string
  plural: string
  kind: string
  namespaced: boolean
  categories: string[]
  /** apiextensions object name (plural.group) for reference. */
  name: string
  /** additionalPrinterColumns from the CRD (default-priority only). */
  printerColumns: Array<{ name: string; jsonPath: string }>
}

/** Descriptor the renderer sends to list/watch an arbitrary custom resource. */
export interface CustomRef {
  group: string
  version: string
  plural: string
  namespaced: boolean
}

/** An active port-forward tunnel. */
export interface PortForwardInfo {
  id: string
  namespace: string
  pod: string
  remotePort: number
  localPort: number
  /** Set when forwarding a Service (pod is the resolved backing pod). */
  service?: string
  error?: string
}

/** Generic streaming chunk for logs / exec output (main -> renderer). */
export interface StreamChunk {
  id: string
  /** utf-8 payload. */
  data?: string
  /** stream closed / ended. */
  closed?: boolean
  error?: string
}

export interface LogQuery {
  container?: string
  follow?: boolean
  tailLines?: number
  timestamps?: boolean
  previous?: boolean
  /** Only logs newer than this many seconds. */
  sinceSeconds?: number
}

/** One cluster's summary in the fleet view. Every field is best-effort:
 *  an unreachable or RBAC-limited cluster still returns a row. */
export interface FleetCluster {
  context: string
  cluster?: string
  reachable: boolean
  error?: string
  /** round-trip time of the probe, ms */
  latencyMs?: number
  version?: string
  nodes?: number
  nodesReady?: number
  pods?: number
  podsProblem?: number
  cpuUsed?: number
  cpuTotal?: number
  memUsed?: number
  memTotal?: number
  podCapacity?: number
  metricsAvailable?: boolean
}

/** Build + runtime identity, shown in the About dialog. */
export interface AppInfo {
  name: string
  version: string
  /** how this instance is hosted */
  mode: 'desktop' | 'in-cluster'
  electron?: string
  node?: string
  chrome?: string
  platform?: string
  homepage?: string
}

// ---- AI assistant (desktop only) ----

export type AiProvider = 'anthropic' | 'openai' | 'claude-code'

/** What the renderer sees. The API key itself never leaves the main process. */
export interface AiConfig {
  provider: AiProvider
  /** OpenAI-compatible endpoints only, e.g. http://localhost:11434/v1 */
  baseUrl?: string
  model: string
  hasKey: boolean
  /** external MCP servers whose tools are offered alongside Panope's own */
  mcpServers?: McpServerSpec[]
  /**
   * claude-code only: stop forbidding the CLI's own Bash/Read/Write tools.
   * Those calls run inside the CLI, so they do NOT pass Panope's confirmation
   * card or audit log. Off unless deliberately enabled.
   */
  unrestricted?: boolean
  /** external tools the user chose to stop being asked about */
  allowedExternalTools?: string[]
}

/** One external MCP server: a spawned command, or an HTTP endpoint. */
export interface McpServerSpec {
  name: string
  command?: string
  args?: string[]
  url?: string
}

/** Connection state of a configured external server, for the settings UI. */
export interface McpServerState {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

/** Streamed assistant activity, main -> renderer. */
export type AiEvent =
  | { type: 'user'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | {
      type: 'confirm'
      id: string
      name: string
      summary: string
      args: Record<string, unknown>
      /** a tool from an external MCP server, not one of Panope's own */
      external?: boolean
    }
  | { type: 'confirmed'; id: string; approve: boolean }
  | { type: 'done' }
  | { type: 'error'; error: string }

/** Rendered view state sent along with a message so the model knows where the user is. */
export interface AiUiContext {
  context?: string
  namespace?: string
  view?: string
}

/** Result of asking GitHub for the newest published release. */
export interface UpdateCheck {
  current: string
  latest?: string
  url?: string
  newer: boolean
  /** set when the check could not complete (offline, proxy, rate limit) */
  error?: string
}

export interface ApplyOptions {
  /** Server dry-run: validate + return what would change without persisting. */
  dryRun?: boolean
  /** Take ownership of fields owned by other field managers (SSA force). */
  force?: boolean
}

/** One RBAC question: can <subject> do <verb> on <resource>? */
export interface AccessCheck {
  verb: string
  /** plural resource name, e.g. "pods", "deployments" */
  resource: string
  /** API group ("" for core) */
  group?: string
  namespace?: string
  /** specific object name (resourceNames rules) */
  name?: string
  subresource?: string
}

export interface AccessResult {
  allowed: boolean
  /** authorizer's explanation, when it gives one (why-denied / which rule allowed) */
  reason?: string
  error?: string
}

/** Ask checks as someone else (SubjectAccessReview) - needs RBAC to do so. */
export interface AccessSubject {
  user?: string
  groups?: string[]
}

/** The identity the cluster sees for our requests. */
export interface WhoAmI {
  user: string
  groups: string[]
  /** how the identity was determined */
  source: 'selfsubjectreview' | 'session' | 'kubeconfig'
  /** in-cluster only: resolved Panope role name */
  role?: string
}

/** One recorded action (mutations only - reads are not audited). */
export interface AuditEntry {
  /** epoch ms */
  ts: number
  /** empty on the desktop (kubeconfig identity) */
  user: string
  method: string
  /** human summary of the target, e.g. "deployments default/api" */
  target: string
  ok: boolean
  error?: string
}

/** One entry of a pod directory listing. */
export interface PodFileEntry {
  name: string
  /** d=dir, -=file, l=symlink, other mode chars pass through */
  type: string
  size: number
  mode: string
  modified: string
  /** symlink target, if any */
  linkTo?: string
}

/** Result of a captured (non-interactive) exec. */
export interface ExecCapture {
  out: string
  err: string
  /** null when the exit code could not be determined */
  code: number | null
}

export interface HelmChartSpec {
  release: string
  chart: string
  namespace: string
  /** YAML values passed via --values */
  values?: string
  version?: string
}
