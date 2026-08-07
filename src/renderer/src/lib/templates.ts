// User template library for the Create dialog, persisted in localStorage.
// A template is YAML that may contain {{variable}} placeholders, prompted
// for at use time.

import yaml from 'js-yaml'
import type { K8sObject } from '@shared/types'

export interface Template {
  /** unique name, e.g. "web Deployment (prod)" */
  name: string
  /** k8s Kind this template creates, used to match the current view */
  kind: string
  yaml: string
  builtin?: boolean
}

const KEY = 'panope.templates.v1'

export const BUILTIN_TEMPLATES: Template[] = [
  {
    name: 'Namespace',
    kind: 'Namespace',
    builtin: true,
    yaml: `apiVersion: v1
kind: Namespace
metadata:
  name: {{name}}
  labels:
    managed-by: panope
`
  },
  {
    name: 'ConfigMap',
    kind: 'ConfigMap',
    builtin: true,
    yaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{name}}
  namespace: {{namespace}}
data:
  key: value
`
  },
  {
    name: 'Deployment',
    kind: 'Deployment',
    builtin: true,
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{name}}
  namespace: {{namespace}}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{name}}
  template:
    metadata:
      labels:
        app: {{name}}
    spec:
      containers:
        - name: app
          image: {{image}}
          ports:
            - containerPort: 80
`
  },
  {
    name: 'Service',
    kind: 'Service',
    builtin: true,
    yaml: `apiVersion: v1
kind: Service
metadata:
  name: {{name}}
  namespace: {{namespace}}
spec:
  selector:
    app: {{name}}
  ports:
    - port: 80
      targetPort: 80
`
  },
  {
    name: 'Secret',
    kind: 'Secret',
    builtin: true,
    yaml: `apiVersion: v1
kind: Secret
metadata:
  name: {{name}}
  namespace: {{namespace}}
type: Opaque
stringData:
  key: value
`
  },
  {
    name: 'CronJob',
    kind: 'CronJob',
    builtin: true,
    yaml: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{name}}
  namespace: {{namespace}}
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: {{image}}
              command: ["sh", "-c", "echo hello"]
`
  },
  {
    name: 'Ingress',
    kind: 'Ingress',
    builtin: true,
    yaml: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{name}}
  namespace: {{namespace}}
spec:
  rules:
    - host: {{host}}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{name}}
                port:
                  number: 80
`
  }
]

export function loadUserTemplates(): Template[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as Template[]
    return Array.isArray(raw) ? raw.filter((t) => t && t.name && t.yaml) : []
  } catch {
    return []
  }
}

export function saveUserTemplate(t: Template): void {
  const list = loadUserTemplates().filter((x) => x.name !== t.name)
  list.push({ name: t.name, kind: t.kind, yaml: t.yaml })
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* quota */
  }
}

export function deleteUserTemplate(name: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadUserTemplates().filter((x) => x.name !== name)))
  } catch {
    /* quota */
  }
}

export function allTemplates(): Template[] {
  return [...loadUserTemplates(), ...BUILTIN_TEMPLATES]
}

/** Distinct {{variable}} names in a template, in order of first appearance. */
export function templateVars(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

export function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_, name: string) => values[name] ?? `{{${name}}}`)
}

/** Fields that only make sense on a live object, stripped when templating. */
export function objectToTemplateYaml(obj: K8sObject): string {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>
  delete clone.status
  const meta = clone.metadata as Record<string, unknown> | undefined
  if (meta) {
    delete meta.uid
    delete meta.resourceVersion
    delete meta.creationTimestamp
    delete meta.generation
    delete meta.managedFields
    delete meta.selfLink
    delete meta.ownerReferences
    const ann = meta.annotations as Record<string, string> | undefined
    if (ann) {
      delete ann['kubectl.kubernetes.io/last-applied-configuration']
      delete ann['deployment.kubernetes.io/revision']
      if (Object.keys(ann).length === 0) delete meta.annotations
    }
  }
  // Secrets: never persist actual values into the (plaintext) template store -
  // replace each entry with a {{key}} placeholder prompted at use time.
  if (clone.kind === 'Secret') {
    for (const field of ['data', 'stringData'] as const) {
      const map = clone[field] as Record<string, string> | undefined
      if (map) for (const k of Object.keys(map)) map[k] = `{{${k.replace(/[^a-zA-Z0-9_-]/g, '_')}}}`
    }
  }
  // Services: strip server-assigned networking fields so the template is
  // creatable in a fresh namespace.
  if (clone.kind === 'Service') {
    const spec = clone.spec as Record<string, unknown> | undefined
    if (spec) {
      delete spec.clusterIP
      delete spec.clusterIPs
      delete spec.healthCheckNodePort
      delete spec.ipFamilies
      delete spec.ipFamilyPolicy
      delete spec.internalTrafficPolicy
      const ports = spec.ports as Array<Record<string, unknown>> | undefined
      if (ports) for (const p of ports) delete p.nodePort
    }
  }
  return yaml.dump(clone, { noRefs: true, sortKeys: false, lineWidth: 140 })
}
