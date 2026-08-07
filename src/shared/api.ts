import type {
  ClusterInfo,
  KubeContextInfo,
  KubeconfigFile,
  ListResult,
  MetricsResult,
  MutationResult,
  K8sObject,
  WatchEvent,
  CrdInfo,
  CustomRef,
  PortForwardInfo,
  FleetCluster,
  AppInfo,
  StreamChunk,
  LogQuery,
  ApplyOptions,
  AccessCheck,
  AccessResult,
  AccessSubject,
  WhoAmI,
  AuditEntry,
  ExecCapture,
  HelmChartSpec
} from './types'

/** The surface exposed on `window.api` by the preload bridge. */
export interface PanopeApi {
  // context / cluster
  listContexts(): Promise<KubeContextInfo[]>
  getClusterInfo(): Promise<ClusterInfo>
  setContext(name: string): Promise<MutationResult>
  getNamespaces(): Promise<string[]>
  /** Read-only summary of every kubeconfig context, probed in parallel. */
  fleetSummary(): Promise<FleetCluster[]>
  /** Rejects when the cluster API server is unreachable (connectivity probe). */
  ping(): Promise<void>

  // resources
  listResource(resourceKey: string, namespace?: string): Promise<ListResult>
  countResource(resourceKey: string): Promise<{ total: number; byNs: Record<string, number> } | null>
  getResource(resourceKey: string, name: string, namespace?: string): Promise<K8sObject | null>
  getMetrics(kind: 'pods' | 'nodes'): Promise<MetricsResult>
  getEvents(name: string, namespace?: string, kind?: string): Promise<K8sObject[]>

  // custom resources / CRDs
  listCRDs(): Promise<CrdInfo[]>
  listCustom(ref: CustomRef): Promise<ListResult>
  startWatchCustom(ref: CustomRef): Promise<string>
  listHelmRepos(): Promise<Array<{ name: string; url: string }>>

  // mutations
  applyYaml(yaml: string, opts?: ApplyOptions): Promise<MutationResult>
  deleteResource(resourceKey: string, name: string, namespace?: string): Promise<MutationResult>
  deleteCustom(ref: CustomRef, name: string, namespace?: string): Promise<MutationResult>
  scaleResource(resourceKey: string, name: string, namespace: string | undefined, replicas: number): Promise<MutationResult>
  restartResource(resourceKey: string, name: string, namespace?: string): Promise<MutationResult>
  patchMerge(resourceKey: string, name: string, namespace: string | undefined, patch: object): Promise<MutationResult>
  drainNode(name: string): Promise<MutationResult>
  /** Create/reuse a privileged host-shell pod on the node; exec nsenter into it. */
  nodeShell(node: string): Promise<{ ok: boolean; pod?: K8sObject; error?: string }>
  /** Attach an ephemeral debug container; returns its name for exec. */
  debugPod(namespace: string, name: string): Promise<{ ok: boolean; container?: string; error?: string }>
  rollbackDeployment(name: string, namespace: string): Promise<MutationResult>
  triggerCronJob(name: string, namespace: string): Promise<MutationResult>
  rerunJob(name: string, namespace: string): Promise<MutationResult>

  // helm lifecycle
  helmUninstall(name: string, namespace: string): Promise<MutationResult>
  helmRollback(name: string, namespace: string, revision: number): Promise<MutationResult>
  helmHistory(name: string, namespace: string): Promise<Array<Record<string, unknown>>>
  helmGet(name: string, namespace: string, what: 'values' | 'manifest' | 'notes'): Promise<string>

  // argocd
  argoSync(namespace: string, name: string): Promise<MutationResult>
  argoRefresh(namespace: string, name: string): Promise<MutationResult>

  // access / RBAC introspection
  /** Batch of SelfSubjectAccessReviews; with `as` set, SubjectAccessReviews. */
  canI(checks: AccessCheck[], as?: AccessSubject): Promise<AccessResult[]>
  whoAmI(): Promise<WhoAmI>

  // audit trail (mutations recorded by this app instance / deployment)
  auditLog(): Promise<AuditEntry[]>

  // pod files (non-interactive exec)
  /** Run a short command in a container and capture its output (bounded). */
  podExecCapture(namespace: string, pod: string, container: string, command: string[]): Promise<ExecCapture>
  /** Write a file into a container from base64 content (small files). */
  podWriteFile(namespace: string, pod: string, container: string, path: string, b64: string): Promise<MutationResult>

  // helm install / upgrade
  helmInstall(spec: HelmChartSpec): Promise<MutationResult>
  helmUpgrade(spec: HelmChartSpec): Promise<MutationResult>
  /** Default values of a repo chart (`helm show values`). */
  helmShowValues(chart: string, version?: string): Promise<string>

  // cross-context reads (desktop only - the server has a single context)
  getResourceInContext(context: string, resourceKey: string, name: string, namespace?: string): Promise<K8sObject | null>

  // kubeconfig files (desktop only). Several files are merged into one view,
  // kubectl-style: the first file to define a name wins.
  listKubeconfigs(): Promise<KubeconfigFile[]>
  addKubeconfig(path: string): Promise<MutationResult>
  removeKubeconfig(path: string): Promise<MutationResult>
  /** Native file picker; resolves to null when the user cancels. */
  browseForKubeconfig(): Promise<string | null>

  // watch (list views)
  startWatch(resourceKey: string, namespace?: string): Promise<string>
  stopWatch(subscriptionId: string): Promise<void>
  onWatchEvent(cb: (event: WatchEvent) => void): () => void

  // logs
  logsStart(namespace: string, pod: string, query: LogQuery): Promise<string>
  logsStop(id: string): Promise<void>
  onLogData(cb: (chunk: StreamChunk) => void): () => void

  // exec / terminal
  execStart(namespace: string, pod: string, container: string, command: string[]): Promise<string>
  execInput(id: string, data: string): Promise<void>
  execResize(id: string, cols: number, rows: number): Promise<void>
  execStop(id: string): Promise<void>
  onExecData(cb: (chunk: StreamChunk) => void): () => void

  // port forwarding
  pfStart(namespace: string, pod: string, remotePort: number, localPort?: number): Promise<PortForwardInfo>
  pfStartService(namespace: string, service: string, servicePort: number, localPort?: number): Promise<PortForwardInfo>
  pfStop(id: string): Promise<void>
  pfList(): Promise<PortForwardInfo[]>
  onPfEvent(cb: (info: PortForwardInfo) => void): () => void

  // misc
  openExternal(url: string): Promise<void>
  getAppInfo(): Promise<AppInfo>
  /** native application-menu selections (desktop only) */
  onMenuAction(cb: (action: string) => void): () => void
  getReadOnly(): Promise<boolean>
  setReadOnly(value: boolean): Promise<boolean>
  /** kubeconfig file changed on disk and was reloaded in the main process. */
  onKubeconfigChanged(cb: (info: { currentContextStillExists: boolean }) => void): () => void
}
