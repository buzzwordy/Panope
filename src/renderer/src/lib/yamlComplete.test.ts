import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'

const SCHEMAS: Record<string, any> = {
  'io.k8s.api.apps.v1.Deployment': {
    'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
    properties: {
      apiVersion: { type: 'string' },
      kind: { type: 'string' },
      spec: { allOf: [{ $ref: '#/components/schemas/Spec' }] }
    }
  },
  Spec: {
    properties: {
      replicas: { type: 'integer', description: 'Number of desired pods.' },
      paused: { type: 'boolean' },
      template: { allOf: [{ $ref: '#/components/schemas/Tpl' }] }
    }
  },
  Tpl: { properties: { spec: { allOf: [{ $ref: '#/components/schemas/PodSpec' }] } } },
  PodSpec: {
    properties: {
      containers: { type: 'array', items: { $ref: '#/components/schemas/Container' } }
    }
  },
  Container: { properties: { name: { type: 'string' }, image: { type: 'string' }, env: { type: 'array', items: {} } } }
}

vi.mock('../api', () => ({ api: { openApiSchemas: vi.fn(async () => SCHEMAS) } }))
const { yamlSchemaCompletions } = await import('./yamlSchema')

function completeAt(doc: string, pos: number) {
  const state = EditorState.create({ doc })
  return yamlSchemaCompletions(new CompletionContext(state, pos, false))
}

describe('yaml completion source', () => {
  it('offers Deployment spec fields under spec:', async () => {
    const doc = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  re'
    const res = await completeAt(doc, doc.length)
    expect(res).toBeTruthy()
    expect(res!.options.map((o) => o.label)).toContain('replicas')
    // description surfaces as the completion info
    expect(res!.options.find((o) => o.label === 'replicas')?.info).toContain('desired pods')
  })

  it('offers container fields inside the containers array', async () => {
    const doc =
      'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - name: a\n          i'
    const res = await completeAt(doc, doc.length)
    expect(res!.options.map((o) => o.label)).toContain('image')
  })

  it('does not re-suggest a key already present at the same level', async () => {
    const doc = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: 2\n  p'
    const res = await completeAt(doc, doc.length)
    const labels = res!.options.map((o) => o.label)
    expect(labels).toContain('paused')
    expect(labels).not.toContain('replicas')
  })

  it('stays silent while typing a value, not a key', async () => {
    const doc = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: 2'
    expect(await completeAt(doc, doc.length)).toBeNull()
  })

  it('stays silent without apiVersion/kind', async () => {
    const doc = 'foo:\n  ba'
    expect(await completeAt(doc, doc.length)).toBeNull()
  })
})
