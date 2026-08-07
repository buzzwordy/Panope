import { describe, it, expect } from 'vitest'
import type { K8sObject } from '@shared/types'
import { podResourceRef, nodeAllocatable, usageReference } from './usage'

function podWith(containers: unknown[]): K8sObject {
  return { spec: { containers } } as unknown as K8sObject
}

describe('podResourceRef', () => {
  it('sums container limits', () => {
    const p = podWith([
      { resources: { limits: { cpu: '100m', memory: '128Mi' } } },
      { resources: { limits: { cpu: '200m', memory: '128Mi' } } }
    ])
    expect(podResourceRef(p, 'cpu')).toBe(300)
    expect(podResourceRef(p, 'memory')).toBe(256 * 2 ** 20)
  })
  it('falls back to requests when limits are absent', () => {
    const p = podWith([{ resources: { requests: { cpu: '50m' } } }])
    expect(podResourceRef(p, 'cpu')).toBe(50)
  })
  it('returns 0 when neither limits nor requests exist', () => {
    expect(podResourceRef(podWith([{}]), 'cpu')).toBe(0)
    expect(podResourceRef(podWith([]), 'memory')).toBe(0)
  })
})

describe('nodeAllocatable', () => {
  it('reads status.allocatable', () => {
    const node = { status: { allocatable: { cpu: '4', memory: '8Gi' } } } as unknown as K8sObject
    expect(nodeAllocatable(node, 'cpu')).toBe(4000)
    expect(nodeAllocatable(node, 'memory')).toBe(8 * 2 ** 30)
  })
  it('returns 0 when missing', () => {
    expect(nodeAllocatable({} as K8sObject, 'cpu')).toBe(0)
  })
})

describe('usageReference', () => {
  it('uses node allocatable as a true percentage denominator', () => {
    const node = { status: { allocatable: { cpu: '2' } } } as unknown as K8sObject
    expect(usageReference('Node', node, 'cpu', 999)).toEqual({ ref: 2000, isPercent: true })
  })
  it('uses pod limits as a true percentage denominator', () => {
    const p = podWith([{ resources: { limits: { cpu: '500m' } } }])
    expect(usageReference('Pod', p, 'cpu', 999)).toEqual({ ref: 500, isPercent: true })
  })
  it('falls back to the comparative max when no denominator exists', () => {
    expect(usageReference('Pod', podWith([]), 'cpu', 750)).toEqual({ ref: 750, isPercent: false })
  })
})
