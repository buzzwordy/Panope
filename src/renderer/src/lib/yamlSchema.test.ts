import { describe, expect, it } from 'vitest'
import { deref, pathToCursor, schemaAtPath, findRootSchema } from './yamlSchema'

// A miniature of the real k8s OpenAPI v3 shape: allOf/$ref wrappers,
// array items, and x-kubernetes-group-version-kind on the root.
const schemas: Record<string, any> = {
  'io.k8s.api.apps.v1.Deployment': {
    'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
    type: 'object',
    properties: {
      apiVersion: { type: 'string' },
      kind: { type: 'string' },
      spec: { description: 'spec', allOf: [{ $ref: '#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec' }] }
    }
  },
  'io.k8s.api.apps.v1.DeploymentSpec': {
    type: 'object',
    properties: {
      replicas: { type: 'integer' },
      template: { allOf: [{ $ref: '#/components/schemas/io.k8s.api.core.v1.PodTemplateSpec' }] }
    }
  },
  'io.k8s.api.core.v1.PodTemplateSpec': {
    type: 'object',
    properties: { spec: { allOf: [{ $ref: '#/components/schemas/io.k8s.api.core.v1.PodSpec' }] } }
  },
  'io.k8s.api.core.v1.PodSpec': {
    type: 'object',
    properties: {
      containers: {
        type: 'array',
        items: { $ref: '#/components/schemas/io.k8s.api.core.v1.Container' }
      }
    }
  },
  'io.k8s.api.core.v1.Container': {
    type: 'object',
    properties: {
      name: { type: 'string' },
      image: { type: 'string' },
      resources: { type: 'object', properties: { limits: { type: 'object' }, requests: { type: 'object' } } }
    }
  }
}

describe('yaml schema resolver', () => {
  it('finds the root schema by group/version/kind', () => {
    expect(findRootSchema(schemas, 'apps/v1', 'Deployment')).toBe(schemas['io.k8s.api.apps.v1.Deployment'])
    expect(findRootSchema(schemas, 'apps/v1', 'Nope')).toBeNull()
  })

  it('derefs allOf/$ref wrappers to the concrete object', () => {
    const spec = schemas['io.k8s.api.apps.v1.Deployment'].properties.spec
    expect(deref(spec, schemas).properties.replicas).toBeDefined()
  })

  it('reads the key path from indentation, ignoring list dashes', () => {
    const lines = ['apiVersion: apps/v1', 'kind: Deployment', 'spec:', '  template:', '    spec:', '      containers:', '        - name: c', '          ']
    expect(pathToCursor(lines, 7)).toEqual(['spec', 'template', 'spec', 'containers'])
  })

  it('walks into array items so container fields resolve', () => {
    const root = findRootSchema(schemas, 'apps/v1', 'Deployment')
    const node = schemaAtPath(root, ['spec', 'template', 'spec', 'containers'], schemas)
    expect(Object.keys(node.properties).sort()).toEqual(['image', 'name', 'resources'])
  })

  it('returns the DeploymentSpec fields at spec level', () => {
    const root = findRootSchema(schemas, 'apps/v1', 'Deployment')
    const node = schemaAtPath(root, ['spec'], schemas)
    expect(Object.keys(node.properties)).toContain('replicas')
  })
})
