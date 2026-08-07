import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ClusterInfo,
  KubeContextInfo,
  ListResult,
  MetricsResult,
  MutationResult,
  K8sObject,
  WatchEvent,
  CrdInfo,
  CustomRef,
  PortForwardInfo,
  StreamChunk,
  LogQuery
} from '../shared/types'
import type { PanopeApi } from '../shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: PanopeApi = {
  // context / cluster
  listContexts: (): Promise<KubeContextInfo[]> => ipcRenderer.invoke(IPC.listContexts),
  getClusterInfo: (): Promise<ClusterInfo> => ipcRenderer.invoke(IPC.getClusterInfo),
  setContext: (name): Promise<MutationResult> => ipcRenderer.invoke(IPC.setContext, name),
  getNamespaces: (): Promise<string[]> => ipcRenderer.invoke(IPC.getNamespaces),
  fleetSummary: () => ipcRenderer.invoke(IPC.fleetSummary),
  ping: (): Promise<void> => ipcRenderer.invoke(IPC.ping),

  // resources
  listResource: (key, ns): Promise<ListResult> => ipcRenderer.invoke(IPC.listResource, key, ns),
  countResource: (key): Promise<{ total: number; byNs: Record<string, number>; partial?: boolean } | null> =>
    ipcRenderer.invoke(IPC.countResource, key),
  getResource: (key, name, ns): Promise<K8sObject | null> =>
    ipcRenderer.invoke(IPC.getResource, key, name, ns),
  getMetrics: (kind): Promise<MetricsResult> => ipcRenderer.invoke(IPC.getMetrics, kind),
  getEvents: (name, ns, kind): Promise<K8sObject[]> => ipcRenderer.invoke(IPC.getEvents, name, ns, kind),

  // custom resources / CRDs
  listCRDs: (): Promise<CrdInfo[]> => ipcRenderer.invoke(IPC.listCRDs),
  listCustom: (ref: CustomRef): Promise<ListResult> => ipcRenderer.invoke(IPC.listCustom, ref),
  startWatchCustom: (ref: CustomRef): Promise<string> => ipcRenderer.invoke(IPC.startWatchCustom, ref),
  listHelmRepos: (): Promise<Array<{ name: string; url: string }>> => ipcRenderer.invoke(IPC.listHelmRepos),

  // mutations
  applyYaml: (yaml, opts): Promise<MutationResult> => ipcRenderer.invoke(IPC.applyYaml, yaml, opts),
  deleteResource: (key, name, ns): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.deleteResource, key, name, ns),
  deleteCustom: (ref, name, ns): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.deleteCustom, ref, name, ns),
  scaleResource: (key, name, ns, replicas): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.scaleResource, key, name, ns, replicas),
  restartResource: (key, name, ns): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.restartResource, key, name, ns),
  patchMerge: (key, name, ns, patch): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.patchMerge, key, name, ns, patch),
  drainNode: (name): Promise<MutationResult> => ipcRenderer.invoke(IPC.drainNode, name),
  nodeShell: (node) => ipcRenderer.invoke(IPC.nodeShell, node),
  debugPod: (namespace, name) => ipcRenderer.invoke(IPC.debugPod, namespace, name),
  rollbackDeployment: (name, ns): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.rollbackDeployment, name, ns),
  triggerCronJob: (name, ns): Promise<MutationResult> => ipcRenderer.invoke(IPC.triggerCronJob, name, ns),
  rerunJob: (name, ns): Promise<MutationResult> => ipcRenderer.invoke(IPC.rerunJob, name, ns),
  helmUninstall: (name, ns): Promise<MutationResult> => ipcRenderer.invoke(IPC.helmUninstall, name, ns),
  helmRollback: (name, ns, revision): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.helmRollback, name, ns, revision),
  helmHistory: (name, ns): Promise<Array<Record<string, unknown>>> =>
    ipcRenderer.invoke(IPC.helmHistory, name, ns),
  helmGet: (name, ns, what): Promise<string> => ipcRenderer.invoke(IPC.helmGet, name, ns, what),
  argoSync: (ns, name): Promise<MutationResult> => ipcRenderer.invoke(IPC.argoSync, ns, name),
  argoRefresh: (ns, name): Promise<MutationResult> => ipcRenderer.invoke(IPC.argoRefresh, ns, name),

  // access / RBAC introspection
  canI: (checks, as) => ipcRenderer.invoke(IPC.canI, checks, as),
  whoAmI: () => ipcRenderer.invoke(IPC.whoAmI),

  // audit trail
  auditLog: () => ipcRenderer.invoke(IPC.auditLog),

  // pod files
  podExecCapture: (ns, pod, container, command) =>
    ipcRenderer.invoke(IPC.podExecCapture, ns, pod, container, command),
  podWriteFile: (ns, pod, container, path, b64): Promise<MutationResult> =>
    ipcRenderer.invoke(IPC.podWriteFile, ns, pod, container, path, b64),

  // helm install / upgrade
  helmInstall: (spec): Promise<MutationResult> => ipcRenderer.invoke(IPC.helmInstall, spec),
  helmUpgrade: (spec): Promise<MutationResult> => ipcRenderer.invoke(IPC.helmUpgrade, spec),
  helmShowValues: (chart, version): Promise<string> => ipcRenderer.invoke(IPC.helmShowValues, chart, version),

  // cross-context reads
  getResourceInContext: (context, key, name, ns): Promise<K8sObject | null> =>
    ipcRenderer.invoke(IPC.getResourceInContext, context, key, name, ns),

  // kubeconfig files
  listKubeconfigs: () => ipcRenderer.invoke(IPC.listKubeconfigs),
  addKubeconfig: (path): Promise<MutationResult> => ipcRenderer.invoke(IPC.addKubeconfig, path),
  removeKubeconfig: (path): Promise<MutationResult> => ipcRenderer.invoke(IPC.removeKubeconfig, path),
  browseForKubeconfig: (): Promise<string | null> => ipcRenderer.invoke(IPC.browseForKubeconfig),

  // watch
  startWatch: (key, ns): Promise<string> => ipcRenderer.invoke(IPC.startWatch, key, ns),
  stopWatch: (id): Promise<void> => ipcRenderer.invoke(IPC.stopWatch, id),
  onWatchEvent: (cb): (() => void) => subscribe<WatchEvent>(IPC.watchEvent, cb),

  // logs
  logsStart: (namespace, pod, query: LogQuery): Promise<string> =>
    ipcRenderer.invoke(IPC.logsStart, namespace, pod, query),
  logsStop: (id): Promise<void> => ipcRenderer.invoke(IPC.logsStop, id),
  onLogData: (cb): (() => void) => subscribe<StreamChunk>(IPC.logsData, cb),

  // exec / terminal
  execStart: (namespace, pod, container, command): Promise<string> =>
    ipcRenderer.invoke(IPC.execStart, namespace, pod, container, command),
  execInput: (id, data): Promise<void> => ipcRenderer.invoke(IPC.execInput, id, data),
  execResize: (id, cols, rows): Promise<void> => ipcRenderer.invoke(IPC.execResize, id, cols, rows),
  execStop: (id): Promise<void> => ipcRenderer.invoke(IPC.execStop, id),
  onExecData: (cb): (() => void) => subscribe<StreamChunk>(IPC.execData, cb),

  // port forwarding
  pfStart: (namespace, pod, remotePort, localPort): Promise<PortForwardInfo> =>
    ipcRenderer.invoke(IPC.pfStart, namespace, pod, remotePort, localPort),
  pfStartService: (namespace, service, servicePort, localPort): Promise<PortForwardInfo> =>
    ipcRenderer.invoke(IPC.pfStartService, namespace, service, servicePort, localPort),
  pfStop: (id): Promise<void> => ipcRenderer.invoke(IPC.pfStop, id),
  pfList: (): Promise<PortForwardInfo[]> => ipcRenderer.invoke(IPC.pfList),
  onPfEvent: (cb): (() => void) => subscribe<PortForwardInfo>(IPC.pfEvent, cb),

  // AI assistant
  aiSend: (text, ctx) => ipcRenderer.invoke(IPC.aiSend, text, ctx),
  aiStop: () => ipcRenderer.invoke(IPC.aiStop),
  aiConfirm: (id, approve) => ipcRenderer.invoke(IPC.aiConfirm, id, approve),
  aiReset: () => ipcRenderer.invoke(IPC.aiReset),
  aiHistory: () => ipcRenderer.invoke(IPC.aiHistory),
  aiListModels: (cfg) => ipcRenderer.invoke(IPC.aiListModels, cfg),
  aiGetConfig: () => ipcRenderer.invoke(IPC.aiGetConfig),
  aiSetConfig: (cfg) => ipcRenderer.invoke(IPC.aiSetConfig, cfg),
  onAiEvent: (cb) => subscribe(IPC.aiEvent, cb),

  // misc
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  onMenuAction: (cb): (() => void) => subscribe<string>(IPC.menuAction, cb),
  getReadOnly: (): Promise<boolean> => ipcRenderer.invoke(IPC.getReadOnly),
  checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),
  setReadOnly: (value: boolean): Promise<boolean> => ipcRenderer.invoke(IPC.setReadOnly, value),
  onKubeconfigChanged: (cb): (() => void) =>
    subscribe<{ currentContextStillExists: boolean }>(IPC.kubeconfigChanged, cb)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore - define on window
  window.api = api
}
