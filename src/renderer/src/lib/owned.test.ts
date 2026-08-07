import { describe, it, expect } from 'vitest'
import type { K8sObject } from '@shared/types'
import { getSelector, matchesSelector } from './owned'

describe('getSelector', () => {
  it('prefers spec.selector.matchLabels (Deployment/RS/StatefulSet)', () => {
    const wl = { spec: { selector: { matchLabels: { app: 'web' } } } } as unknown as K8sObject
    expect(getSelector(wl)).toEqual({ app: 'web' })
  })
  it('reads a plain spec.selector map (ReplicationController)', () => {
    const rc = { spec: { selector: { app: 'legacy' } } } as unknown as K8sObject
    expect(getSelector(rc)).toEqual({ app: 'legacy' })
  })
  it('returns null when there is no usable selector', () => {
    expect(getSelector({ spec: {} } as unknown as K8sObject)).toBeNull()
    expect(getSelector({ spec: { selector: { matchLabels: {} } } } as unknown as K8sObject)).toBeNull()
  })
})

function pod(labels: Record<string, string>): K8sObject {
  return { metadata: { labels } } as unknown as K8sObject
}

describe('matchesSelector', () => {
  it('matches when every selector entry is present', () => {
    expect(matchesSelector(pod({ app: 'web', tier: 'fe' }), { app: 'web' })).toBe(true)
    expect(matchesSelector(pod({ app: 'web', tier: 'fe' }), { app: 'web', tier: 'fe' })).toBe(true)
  })
  it('fails when any selector entry differs or is missing', () => {
    expect(matchesSelector(pod({ app: 'web' }), { app: 'api' })).toBe(false)
    expect(matchesSelector(pod({ app: 'web' }), { app: 'web', tier: 'fe' })).toBe(false)
  })
  it('an empty selector matches any pod', () => {
    expect(matchesSelector(pod({ app: 'web' }), {})).toBe(true)
  })
})
