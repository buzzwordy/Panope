// Canonical IPC channel names shared by main + preload. Renderer never sees these
// directly - it talks through the typed `window.api` bridge in the preload.

export const IPC = {
  // kubeconfig / context
  listContexts: 'k8s:listContexts',
  getClusterInfo: 'k8s:getClusterInfo',
  setContext: 'k8s:setContext',
  getNamespaces: 'k8s:getNamespaces',
  fleetSummary: 'k8s:fleetSummary',
  ping: 'k8s:ping',

  // resources
  listResource: 'k8s:listResource',
  countResource: 'k8s:countResource',
  getResource: 'k8s:getResource',
  getMetrics: 'k8s:getMetrics',
  getEvents: 'k8s:getEvents',

  // custom resources / CRDs
  listCRDs: 'k8s:listCRDs',
  listCustom: 'k8s:listCustom',
  startWatchCustom: 'k8s:startWatchCustom',

  // helm repositories
  listHelmRepos: 'k8s:listHelmRepos',

  // mutations
  applyYaml: 'k8s:applyYaml',
  deleteResource: 'k8s:deleteResource',
  deleteCustom: 'k8s:deleteCustom',
  scaleResource: 'k8s:scaleResource',
  restartResource: 'k8s:restartResource',
  patchMerge: 'k8s:patchMerge', // cordon/uncordon, pause/resume, suspend
  drainNode: 'k8s:drainNode',
  nodeShell: 'k8s:nodeShell',
  debugPod: 'k8s:debugPod',
  rollbackDeployment: 'k8s:rollbackDeployment',
  triggerCronJob: 'k8s:triggerCronJob',
  rerunJob: 'k8s:rerunJob',

  // helm lifecycle
  helmUninstall: 'k8s:helmUninstall',
  helmRollback: 'k8s:helmRollback',
  helmHistory: 'k8s:helmHistory',
  helmGet: 'k8s:helmGet',

  // argocd
  argoSync: 'k8s:argoSync',
  argoRefresh: 'k8s:argoRefresh',

  // access / RBAC introspection
  canI: 'k8s:canI',
  whoAmI: 'k8s:whoAmI',

  // audit trail
  auditLog: 'app:auditLog',

  // pod files
  podExecCapture: 'k8s:podExecCapture',
  podWriteFile: 'k8s:podWriteFile',

  // helm install / upgrade
  helmInstall: 'k8s:helmInstall',
  helmUpgrade: 'k8s:helmUpgrade',
  helmShowValues: 'k8s:helmShowValues',

  // cross-context reads
  getResourceInContext: 'k8s:getResourceInContext',

  // watch (streaming)
  startWatch: 'k8s:startWatch',
  stopWatch: 'k8s:stopWatch',
  watchEvent: 'k8s:watchEvent', // main -> renderer push

  // logs (streaming)
  logsStart: 'k8s:logsStart',
  logsStop: 'k8s:logsStop',
  logsData: 'k8s:logsData', // main -> renderer push

  // exec / terminal (bidirectional streaming)
  execStart: 'k8s:execStart',
  execInput: 'k8s:execInput',
  execResize: 'k8s:execResize',
  execStop: 'k8s:execStop',
  execData: 'k8s:execData', // main -> renderer push

  // port forwarding
  pfStart: 'k8s:pfStart',
  pfStartService: 'k8s:pfStartService',
  pfStop: 'k8s:pfStop',
  pfList: 'k8s:pfList',
  pfEvent: 'k8s:pfEvent', // main -> renderer push (errors/close)

  // misc
  openExternal: 'app:openExternal',
  getAppInfo: 'app:getAppInfo',
  menuAction: 'app:menuAction', // main -> renderer push
  getReadOnly: 'app:getReadOnly',
  setReadOnly: 'app:setReadOnly',
  kubeconfigChanged: 'app:kubeconfigChanged' // main -> renderer push
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
