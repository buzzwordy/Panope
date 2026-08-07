import { describe, it, expect } from 'vitest'
import type { K8sObject } from '@shared/types'
import { templateVars, fillTemplate, objectToTemplateYaml } from './templates'

describe('templateVars', () => {
  it('extracts distinct variables in order of first appearance', () => {
    expect(templateVars('name: {{name}}\nns: {{namespace}}\napp: {{name}}')).toEqual(['name', 'namespace'])
  })
  it('tolerates whitespace inside braces', () => {
    expect(templateVars('x: {{ image }}')).toEqual(['image'])
  })
  it('returns empty for a template without variables', () => {
    expect(templateVars('kind: Namespace')).toEqual([])
  })
})

describe('fillTemplate', () => {
  it('replaces every occurrence', () => {
    expect(fillTemplate('a: {{x}}, b: {{x}}', { x: '1' })).toBe('a: 1, b: 1')
  })
  it('leaves unknown variables intact', () => {
    expect(fillTemplate('a: {{x}}, b: {{y}}', { x: '1' })).toBe('a: 1, b: {{y}}')
  })
})

describe('objectToTemplateYaml', () => {
  it('strips server-managed fields and status', () => {
    const obj = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'web',
        namespace: 'default',
        uid: 'abc-123',
        resourceVersion: '999',
        creationTimestamp: '2020-01-01T00:00:00Z',
        generation: 4,
        managedFields: [{ manager: 'kubectl' }],
        ownerReferences: [{ kind: 'X', name: 'y' }],
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{...}',
          'deployment.kubernetes.io/revision': '2',
          keep: 'me'
        },
        labels: { app: 'web' }
      },
      spec: { replicas: 2 },
      status: { readyReplicas: 2 }
    } as unknown as K8sObject
    const out = objectToTemplateYaml(obj)
    expect(out).toContain('name: web')
    expect(out).toContain('keep: me')
    expect(out).toContain('replicas: 2')
    expect(out).not.toContain('uid')
    expect(out).not.toContain('resourceVersion')
    expect(out).not.toContain('managedFields')
    expect(out).not.toContain('ownerReferences')
    expect(out).not.toContain('last-applied-configuration')
    expect(out).not.toContain('status')
  })
  it('never persists Secret values - replaces them with {{key}} placeholders', () => {
    const obj = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 's' },
      type: 'Opaque',
      data: { password: 'c3VwZXJzZWNyZXQ=', 'tls.crt': 'Y2VydA==' },
      stringData: { token: 'plaintext-token' }
    } as unknown as K8sObject
    const out = objectToTemplateYaml(obj)
    expect(out).not.toContain('c3VwZXJzZWNyZXQ=')
    expect(out).not.toContain('Y2VydA==')
    expect(out).not.toContain('plaintext-token')
    expect(out).toContain('{{password}}')
    expect(out).toContain('{{tls_crt}}')
    expect(out).toContain('{{token}}')
  })
  it('strips server-assigned Service networking fields', () => {
    const obj = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'svc' },
      spec: {
        clusterIP: '10.0.0.1',
        clusterIPs: ['10.0.0.1'],
        type: 'NodePort',
        ports: [{ port: 80, targetPort: 80, nodePort: 30123 }]
      }
    } as unknown as K8sObject
    const out = objectToTemplateYaml(obj)
    expect(out).not.toContain('clusterIP')
    expect(out).not.toContain('nodePort')
    expect(out).toContain('port: 80')
  })
  it('drops the annotations map entirely when only server annotations existed', () => {
    const obj = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'c',
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': 'x' }
      },
      data: { k: 'v' }
    } as unknown as K8sObject
    expect(objectToTemplateYaml(obj)).not.toContain('annotations')
  })
})
