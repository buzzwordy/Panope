// The Panope resource catalog - a single source of truth shared by the main
// process (which uses `api` + `listMethod` + `watchPath` + `namespaced`) and the
// renderer (which uses `label`, `category`, `icon`, and `columns`).
//
// Method names were verified against @kubernetes/client-node 1.4.0's ObjectParam API.

import type { CustomRef } from './types'

export type CellKind =
  | 'text'
  | 'number'
  | 'age'
  | 'status'
  | 'ready'
  | 'metric'
  | 'labels'

export interface ColumnDef {
  /** Stable id; also used to look up a computed accessor in the renderer. */
  id: string
  header: string
  kind: CellKind
  /** Dot-path into the object for simple `text`/`number`/`age` cells. */
  field?: string
  align?: 'left' | 'right'
  /** For metric columns: which metric this is. */
  metric?: 'cpu' | 'memory'
  sortable?: boolean
  /** Hidden unless the user enables it in the column chooser (kubectl -o wide style). */
  defaultHidden?: boolean
}

export interface ResourceDef {
  key: string // url-ish slug, e.g. "pods"
  label: string // sidebar + title
  kind: string // k8s Kind
  category: string
  icon: string // icon id resolved in the renderer
  apiVersion: string
  group: string
  namespaced: boolean
  /** @kubernetes/client-node API class name, or "helm" for pseudo-resources. */
  api: string
  /** list-all method on that API class (empty for helm pseudo-resources). */
  listMethod: string
  /** REST path used by the Watch client. */
  watchPath: string
  columns: ColumnDef[]
  /** Suppress the auto-prepended Name column (e.g. Events, whose name is a hash). */
  hideName?: boolean
  /** Id of a column to pull to the very front of the table (before Name/Namespace). */
  leadColumn?: string
  /** True for pseudo/unsupported resources rendered with a friendly placeholder. */
  unsupported?: boolean
  /** Set for dynamically-discovered custom resources (CRDs, ArgoCD, ...). */
  custom?: CustomRef
}

const AGE: ColumnDef = { id: 'age', header: 'Age', kind: 'age', field: 'metadata.creationTimestamp', align: 'right', sortable: true }

export const CATALOG: ResourceDef[] = [
  // ---------------- Infrastructure ----------------
  {
    key: 'nodes', label: 'Nodes', kind: 'Node', category: 'Infrastructure', icon: 'node',
    apiVersion: 'v1', group: '', namespaced: false, api: 'CoreV1Api', listMethod: 'listNode', watchPath: '/api/v1/nodes',
    columns: [
      { id: 'node.status', header: 'Status', kind: 'status', sortable: true },
      { id: 'node.roles', header: 'Roles', kind: 'text' },
      { id: 'node.version', header: 'Version', kind: 'text', field: 'status.nodeInfo.kubeletVersion' },
      { id: 'node.ip', header: 'Internal-IP', kind: 'text' },
      { id: 'cpu', header: 'CPU', kind: 'metric', metric: 'cpu' },
      { id: 'memory', header: 'Memory', kind: 'metric', metric: 'memory' },
      AGE
    ]
  },
  {
    key: 'namespaces', label: 'Namespaces', kind: 'Namespace', category: 'Infrastructure', icon: 'namespace',
    apiVersion: 'v1', group: '', namespaced: false, api: 'CoreV1Api', listMethod: 'listNamespace', watchPath: '/api/v1/namespaces',
    columns: [
      { id: 'ns.status', header: 'Status', kind: 'status', sortable: true },
      AGE
    ]
  },
  {
    key: 'quotas', label: 'Quotas', kind: 'ResourceQuota', category: 'Infrastructure', icon: 'quota',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listResourceQuotaForAllNamespaces', watchPath: '/api/v1/resourcequotas',
    columns: [AGE]
  },
  {
    key: 'limits', label: 'Limits', kind: 'LimitRange', category: 'Infrastructure', icon: 'limit',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listLimitRangeForAllNamespaces', watchPath: '/api/v1/limitranges',
    columns: [AGE]
  },
  {
    key: 'events', label: 'Events', kind: 'Event', category: 'Infrastructure', icon: 'event',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listEventForAllNamespaces', watchPath: '/api/v1/events',
    hideName: true, leadColumn: 'event.last',
    columns: [
      { id: 'event.last', header: 'Last Seen', kind: 'age', field: 'lastTimestamp', sortable: true },
      { id: 'event.type', header: 'Type', kind: 'status', sortable: true },
      { id: 'reason', header: 'Reason', kind: 'text', field: 'reason' },
      { id: 'event.object', header: 'Object', kind: 'text' },
      { id: 'message', header: 'Message', kind: 'text', field: 'message' }
    ]
  },

  // ---------------- Workloads ----------------
  {
    key: 'pods', label: 'Pods', kind: 'Pod', category: 'Workloads', icon: 'pod',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listPodForAllNamespaces', watchPath: '/api/v1/pods',
    columns: [
      { id: 'cpu', header: 'CPU', kind: 'metric', metric: 'cpu' },
      { id: 'memory', header: 'Memory', kind: 'metric', metric: 'memory' },
      { id: 'pod.ready', header: 'Ready', kind: 'ready', sortable: true },
      { id: 'pod.status', header: 'Status', kind: 'status', sortable: true },
      { id: 'pod.restarts', header: 'Restarts', kind: 'number', align: 'right', sortable: true },
      { id: 'pod.ip', header: 'IP', kind: 'text', field: 'status.podIP', defaultHidden: true },
      { id: 'pod.node', header: 'Node', kind: 'text', field: 'spec.nodeName', sortable: true, defaultHidden: true },
      AGE
    ]
  },
  {
    key: 'deployments', label: 'Deployments', kind: 'Deployment', category: 'Workloads', icon: 'deploy',
    apiVersion: 'apps/v1', group: 'apps', namespaced: true, api: 'AppsV1Api', listMethod: 'listDeploymentForAllNamespaces', watchPath: '/apis/apps/v1/deployments',
    columns: [
      { id: 'deploy.ready', header: 'Ready', kind: 'ready', sortable: true },
      { id: 'deploy.uptodate', header: 'Up-to-date', kind: 'number', field: 'status.updatedReplicas', align: 'right' },
      { id: 'deploy.available', header: 'Available', kind: 'number', field: 'status.availableReplicas', align: 'right' },
      AGE
    ]
  },
  {
    key: 'statefulsets', label: 'StatefulSets', kind: 'StatefulSet', category: 'Workloads', icon: 'sts',
    apiVersion: 'apps/v1', group: 'apps', namespaced: true, api: 'AppsV1Api', listMethod: 'listStatefulSetForAllNamespaces', watchPath: '/apis/apps/v1/statefulsets',
    columns: [
      { id: 'sts.ready', header: 'Ready', kind: 'ready', sortable: true },
      AGE
    ]
  },
  {
    key: 'daemonsets', label: 'DaemonSets', kind: 'DaemonSet', category: 'Workloads', icon: 'ds',
    apiVersion: 'apps/v1', group: 'apps', namespaced: true, api: 'AppsV1Api', listMethod: 'listDaemonSetForAllNamespaces', watchPath: '/apis/apps/v1/daemonsets',
    columns: [
      { id: 'ds.desired', header: 'Desired', kind: 'number', field: 'status.desiredNumberScheduled', align: 'right' },
      { id: 'ds.current', header: 'Current', kind: 'number', field: 'status.currentNumberScheduled', align: 'right' },
      { id: 'ds.ready', header: 'Ready', kind: 'number', field: 'status.numberReady', align: 'right' },
      { id: 'ds.available', header: 'Available', kind: 'number', field: 'status.numberAvailable', align: 'right' },
      AGE
    ]
  },
  {
    key: 'jobs', label: 'Jobs', kind: 'Job', category: 'Workloads', icon: 'job',
    apiVersion: 'batch/v1', group: 'batch', namespaced: true, api: 'BatchV1Api', listMethod: 'listJobForAllNamespaces', watchPath: '/apis/batch/v1/jobs',
    columns: [
      { id: 'job.status', header: 'Status', kind: 'status', sortable: true },
      { id: 'job.completions', header: 'Completions', kind: 'ready' },
      { id: 'job.duration', header: 'Duration', kind: 'text', align: 'right' },
      AGE
    ]
  },
  {
    key: 'cronjobs', label: 'CronJobs', kind: 'CronJob', category: 'Workloads', icon: 'cronjob',
    apiVersion: 'batch/v1', group: 'batch', namespaced: true, api: 'BatchV1Api', listMethod: 'listCronJobForAllNamespaces', watchPath: '/apis/batch/v1/cronjobs',
    columns: [
      { id: 'cron.schedule', header: 'Schedule', kind: 'text', field: 'spec.schedule' },
      { id: 'cron.suspend', header: 'Suspend', kind: 'text', field: 'spec.suspend' },
      { id: 'cron.active', header: 'Active', kind: 'number', align: 'right' },
      { id: 'cron.last', header: 'Last Schedule', kind: 'age', field: 'status.lastScheduleTime', align: 'right' },
      AGE
    ]
  },
  {
    key: 'replicasets', label: 'ReplicaSets', kind: 'ReplicaSet', category: 'Workloads', icon: 'rs',
    apiVersion: 'apps/v1', group: 'apps', namespaced: true, api: 'AppsV1Api', listMethod: 'listReplicaSetForAllNamespaces', watchPath: '/apis/apps/v1/replicasets',
    columns: [
      { id: 'rs.desired', header: 'Desired', kind: 'number', field: 'spec.replicas', align: 'right' },
      { id: 'rs.current', header: 'Current', kind: 'number', field: 'status.replicas', align: 'right' },
      { id: 'rs.ready', header: 'Ready', kind: 'number', field: 'status.readyReplicas', align: 'right' },
      AGE
    ]
  },
  {
    key: 'replicationcontrollers', label: 'ReplicationControllers', kind: 'ReplicationController', category: 'Workloads', icon: 'rs',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listReplicationControllerForAllNamespaces', watchPath: '/api/v1/replicationcontrollers',
    columns: [
      { id: 'rc.desired', header: 'Desired', kind: 'number', field: 'spec.replicas', align: 'right' },
      { id: 'rc.current', header: 'Current', kind: 'number', field: 'status.replicas', align: 'right' },
      { id: 'rc.ready', header: 'Ready', kind: 'number', field: 'status.readyReplicas', align: 'right' },
      AGE
    ]
  },

  // ---------------- Configuration ----------------
  {
    key: 'configmaps', label: 'Config', kind: 'ConfigMap', category: 'Configuration', icon: 'config',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listConfigMapForAllNamespaces', watchPath: '/api/v1/configmaps',
    columns: [
      { id: 'cm.keys', header: 'Keys', kind: 'number', align: 'right' },
      AGE
    ]
  },
  {
    key: 'secrets', label: 'Secrets', kind: 'Secret', category: 'Configuration', icon: 'secret',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listSecretForAllNamespaces', watchPath: '/api/v1/secrets',
    columns: [
      { id: 'secret.type', header: 'Type', kind: 'text', field: 'type' },
      { id: 'secret.keys', header: 'Keys', kind: 'number', align: 'right' },
      AGE
    ]
  },
  {
    key: 'hpa', label: 'Autoscalers', kind: 'HorizontalPodAutoscaler', category: 'Configuration', icon: 'autoscaler',
    apiVersion: 'autoscaling/v2', group: 'autoscaling', namespaced: true, api: 'AutoscalingV2Api', listMethod: 'listHorizontalPodAutoscalerForAllNamespaces', watchPath: '/apis/autoscaling/v2/horizontalpodautoscalers',
    columns: [
      { id: 'hpa.reference', header: 'Reference', kind: 'text' },
      { id: 'hpa.min', header: 'Min', kind: 'number', field: 'spec.minReplicas', align: 'right' },
      { id: 'hpa.max', header: 'Max', kind: 'number', field: 'spec.maxReplicas', align: 'right' },
      { id: 'hpa.replicas', header: 'Replicas', kind: 'number', field: 'status.currentReplicas', align: 'right' },
      AGE
    ]
  },
  {
    key: 'pdb', label: 'PodDisruptionBudgets', kind: 'PodDisruptionBudget', category: 'Configuration', icon: 'pdb',
    apiVersion: 'policy/v1', group: 'policy', namespaced: true, api: 'PolicyV1Api', listMethod: 'listPodDisruptionBudgetForAllNamespaces', watchPath: '/apis/policy/v1/poddisruptionbudgets',
    columns: [
      { id: 'pdb.min', header: 'Min Available', kind: 'text', field: 'spec.minAvailable' },
      { id: 'pdb.max', header: 'Max Unavailable', kind: 'text', field: 'spec.maxUnavailable' },
      { id: 'pdb.allowed', header: 'Allowed Disruptions', kind: 'number', field: 'status.disruptionsAllowed', align: 'right' },
      AGE
    ]
  },

  // ---------------- Networking ----------------
  {
    key: 'services', label: 'Services', kind: 'Service', category: 'Networking', icon: 'service',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listServiceForAllNamespaces', watchPath: '/api/v1/services',
    columns: [
      { id: 'svc.type', header: 'Type', kind: 'text', field: 'spec.type' },
      { id: 'svc.clusterip', header: 'Cluster-IP', kind: 'text', field: 'spec.clusterIP' },
      { id: 'svc.external', header: 'External-IP', kind: 'text' },
      { id: 'svc.ports', header: 'Port(s)', kind: 'text' },
      AGE
    ]
  },
  {
    key: 'ingresses', label: 'Ingresses', kind: 'Ingress', category: 'Networking', icon: 'ingress',
    apiVersion: 'networking.k8s.io/v1', group: 'networking.k8s.io', namespaced: true, api: 'NetworkingV1Api', listMethod: 'listIngressForAllNamespaces', watchPath: '/apis/networking.k8s.io/v1/ingresses',
    columns: [
      { id: 'ing.class', header: 'Class', kind: 'text', field: 'spec.ingressClassName' },
      { id: 'ing.hosts', header: 'Hosts', kind: 'text' },
      { id: 'ing.address', header: 'Address', kind: 'text' },
      AGE
    ]
  },
  {
    key: 'networkpolicies', label: 'NetworkPolicies', kind: 'NetworkPolicy', category: 'Networking', icon: 'netpol',
    apiVersion: 'networking.k8s.io/v1', group: 'networking.k8s.io', namespaced: true, api: 'NetworkingV1Api', listMethod: 'listNetworkPolicyForAllNamespaces', watchPath: '/apis/networking.k8s.io/v1/networkpolicies',
    columns: [AGE]
  },
  {
    key: 'endpoints', label: 'Endpoints', kind: 'Endpoints', category: 'Networking', icon: 'endpoint',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listEndpointsForAllNamespaces', watchPath: '/api/v1/endpoints',
    columns: [
      { id: 'ep.addresses', header: 'Endpoints', kind: 'text' },
      AGE
    ]
  },
  {
    key: 'ingressclasses', label: 'IngressClasses', kind: 'IngressClass', category: 'Networking', icon: 'ingress',
    apiVersion: 'networking.k8s.io/v1', group: 'networking.k8s.io', namespaced: false, api: 'NetworkingV1Api', listMethod: 'listIngressClass', watchPath: '/apis/networking.k8s.io/v1/ingressclasses',
    columns: [
      { id: 'ic.controller', header: 'Controller', kind: 'text', field: 'spec.controller' },
      AGE
    ]
  },

  // ---------------- Storage ----------------
  {
    key: 'persistentvolumes', label: 'Volumes', kind: 'PersistentVolume', category: 'Storage', icon: 'volume',
    apiVersion: 'v1', group: '', namespaced: false, api: 'CoreV1Api', listMethod: 'listPersistentVolume', watchPath: '/api/v1/persistentvolumes',
    columns: [
      { id: 'pv.capacity', header: 'Capacity', kind: 'text', field: 'spec.capacity.storage' },
      { id: 'pv.access', header: 'Access Modes', kind: 'text' },
      { id: 'pv.reclaim', header: 'Reclaim Policy', kind: 'text', field: 'spec.persistentVolumeReclaimPolicy' },
      { id: 'pv.status', header: 'Status', kind: 'status', sortable: true },
      { id: 'pv.claim', header: 'Claim', kind: 'text' },
      { id: 'pv.sc', header: 'StorageClass', kind: 'text', field: 'spec.storageClassName' },
      { id: 'pv.vac', header: 'VolumeAttributesClass', kind: 'text', field: 'spec.volumeAttributesClassName' },
      { id: 'pv.reason', header: 'Reason', kind: 'text', field: 'status.reason' },
      AGE
    ]
  },
  {
    key: 'persistentvolumeclaims', label: 'Claims', kind: 'PersistentVolumeClaim', category: 'Storage', icon: 'claim',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listPersistentVolumeClaimForAllNamespaces', watchPath: '/api/v1/persistentvolumeclaims',
    columns: [
      { id: 'pvc.status', header: 'Status', kind: 'status', sortable: true },
      { id: 'pvc.volume', header: 'Volume', kind: 'text', field: 'spec.volumeName' },
      { id: 'pvc.capacity', header: 'Capacity', kind: 'text', field: 'status.capacity.storage' },
      { id: 'pvc.sc', header: 'StorageClass', kind: 'text', field: 'spec.storageClassName' },
      AGE
    ]
  },
  {
    key: 'storageclasses', label: 'StorageClasses', kind: 'StorageClass', category: 'Storage', icon: 'sc',
    apiVersion: 'storage.k8s.io/v1', group: 'storage.k8s.io', namespaced: false, api: 'StorageV1Api', listMethod: 'listStorageClass', watchPath: '/apis/storage.k8s.io/v1/storageclasses',
    columns: [
      { id: 'sc.provisioner', header: 'Provisioner', kind: 'text', field: 'provisioner' },
      { id: 'sc.reclaim', header: 'Reclaim Policy', kind: 'text', field: 'reclaimPolicy' },
      AGE
    ]
  },

  // ---------------- Applications (Helm - via the helm CLI) ----------------
  {
    key: 'charts', label: 'Charts', kind: 'Chart', category: 'Applications', icon: 'chart',
    apiVersion: '', group: 'helm', namespaced: false, api: 'helm', listMethod: '', watchPath: '',
    columns: [
      { id: 'chart.version', header: 'Chart Version', kind: 'text', field: 'chartVersion' },
      { id: 'chart.appversion', header: 'App Version', kind: 'text', field: 'appVersion' },
      { id: 'chart.description', header: 'Description', kind: 'text', field: 'description' }
    ]
  },
  {
    key: 'releases', label: 'Releases', kind: 'Release', category: 'Applications', icon: 'release',
    apiVersion: '', group: 'helm', namespaced: true, api: 'helm', listMethod: '', watchPath: '',
    columns: [
      { id: 'rel.revision', header: 'Revision', kind: 'number', field: 'revision', align: 'right' },
      { id: 'rel.status', header: 'Status', kind: 'status', sortable: true },
      { id: 'rel.chart', header: 'Chart', kind: 'text', field: 'chart' },
      { id: 'rel.appversion', header: 'App Version', kind: 'text', field: 'appVersion' },
      { id: 'rel.updated', header: 'Updated', kind: 'text', field: 'updatedText' }
    ]
  },

  // ---------------- Users (RBAC) ----------------
  {
    key: 'serviceaccounts', label: 'ServiceAccounts', kind: 'ServiceAccount', category: 'Users', icon: 'sa',
    apiVersion: 'v1', group: '', namespaced: true, api: 'CoreV1Api', listMethod: 'listServiceAccountForAllNamespaces', watchPath: '/api/v1/serviceaccounts',
    columns: [
      { id: 'sa.secrets', header: 'Secrets', kind: 'number', align: 'right' },
      AGE
    ]
  },
  {
    key: 'roles', label: 'Roles', kind: 'Role', category: 'Users', icon: 'role',
    apiVersion: 'rbac.authorization.k8s.io/v1', group: 'rbac.authorization.k8s.io', namespaced: true, api: 'RbacAuthorizationV1Api', listMethod: 'listRoleForAllNamespaces', watchPath: '/apis/rbac.authorization.k8s.io/v1/roles',
    columns: [AGE]
  },
  {
    key: 'rolebindings', label: 'RoleBindings', kind: 'RoleBinding', category: 'Users', icon: 'rolebinding',
    apiVersion: 'rbac.authorization.k8s.io/v1', group: 'rbac.authorization.k8s.io', namespaced: true, api: 'RbacAuthorizationV1Api', listMethod: 'listRoleBindingForAllNamespaces', watchPath: '/apis/rbac.authorization.k8s.io/v1/rolebindings',
    columns: [
      { id: 'rb.role', header: 'Role', kind: 'text' },
      AGE
    ]
  },
  {
    key: 'clusterroles', label: 'ClusterRoles', kind: 'ClusterRole', category: 'Users', icon: 'role',
    apiVersion: 'rbac.authorization.k8s.io/v1', group: 'rbac.authorization.k8s.io', namespaced: false, api: 'RbacAuthorizationV1Api', listMethod: 'listClusterRole', watchPath: '/apis/rbac.authorization.k8s.io/v1/clusterroles',
    columns: [AGE]
  },
  {
    key: 'clusterrolebindings', label: 'ClusterRoleBindings', kind: 'ClusterRoleBinding', category: 'Users', icon: 'rolebinding',
    apiVersion: 'rbac.authorization.k8s.io/v1', group: 'rbac.authorization.k8s.io', namespaced: false, api: 'RbacAuthorizationV1Api', listMethod: 'listClusterRoleBinding', watchPath: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
    columns: [
      { id: 'crb.role', header: 'Role', kind: 'text' },
      AGE
    ]
  }
]

export const CATEGORY_ORDER = [
  'Infrastructure',
  'Workloads',
  'Configuration',
  'Networking',
  'Storage',
  'Applications',
  'Users',
  'ArgoCD',
  'Custom Resources'
]

const BY_KEY = new Map(CATALOG.map((r) => [r.key, r]))

export function getResourceDef(key: string): ResourceDef | undefined {
  return BY_KEY.get(key)
}

export interface CategoryGroup {
  name: string
  items: ResourceDef[]
}

export function groupedCatalog(): CategoryGroup[] {
  return CATEGORY_ORDER.map((name) => ({
    name,
    items: CATALOG.filter((r) => r.category === name)
  })).filter((g) => g.items.length > 0)
}
