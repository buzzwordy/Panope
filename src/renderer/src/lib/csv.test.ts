import { describe, it, expect } from 'vitest'
import type { ResourceDef } from '@shared/catalog'
import type { K8sObject } from '@shared/types'
import { toCsv } from './csv'

const podsDef = {
  key: 'pods',
  label: 'Pods',
  kind: 'Pod',
  namespaced: true,
  columns: [
    { id: 'pod.status', header: 'Status', kind: 'status' },
    { id: 'cpu', header: 'CPU', kind: 'metric', metric: 'cpu' },
    { id: 'age', header: 'Age', kind: 'age', field: 'metadata.creationTimestamp' }
  ]
} as unknown as ResourceDef

function pod(name: string, ns: string, phase = 'Running'): K8sObject {
  return {
    metadata: { name, namespace: ns, creationTimestamp: '2026-01-01T00:00:00Z' },
    status: { phase, containerStatuses: [{ ready: true, state: { running: {} } }] }
  } as unknown as K8sObject
}

describe('toCsv', () => {
  it('emits a header plus one row per item, skipping metric columns', () => {
    const csv = toCsv(podsDef, [pod('web-1', 'default'), pod('api-2', 'prod')], new Set())
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Name,Namespace,Status,Age')
    expect(lines[1]).toBe('web-1,default,Running,2026-01-01T00:00:00Z')
    expect(lines).toHaveLength(3)
    expect(csv).not.toContain('CPU')
  })
  it('honors hidden columns (including namespace)', () => {
    const csv = toCsv(podsDef, [pod('web-1', 'default')], new Set(['namespace', 'pod.status']))
    expect(csv.split('\n')[0]).toBe('Name,Age')
  })
  it('escapes commas, quotes and newlines', () => {
    const weird = {
      metadata: { name: 'a,b"c', namespace: 'ns', creationTimestamp: '' }
    } as unknown as K8sObject
    const csv = toCsv({ ...podsDef, columns: [] } as ResourceDef, [weird], new Set())
    expect(csv.split('\n')[1]).toBe('"a,b""c",ns')
  })
})
