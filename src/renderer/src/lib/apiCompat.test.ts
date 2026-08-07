import { describe, expect, it } from 'vitest'
import { parseManifestRefs, scanApiVersions, compareVersions } from './apiCompat'

const SERVED = [
  'v1',
  'apps/v1',
  'networking.k8s.io/v1',
  'policy/v1',
  'autoscaling/v1',
  'autoscaling/v2',
  'gateway.networking.k8s.io/v1',
  'gateway.networking.k8s.io/v1beta1'
]

describe('parseManifestRefs', () => {
  it('reads every doc in a multi-doc manifest, deduped', () => {
    const m = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: a',
      '---',
      'apiVersion: v1',
      'kind: Service',
      '---',
      'apiVersion: apps/v1',
      'kind: Deployment'
    ].join('\n')
    const refs = parseManifestRefs(m)
    expect(refs).toEqual([
      { apiVersion: 'apps/v1', kind: 'Deployment' },
      { apiVersion: 'v1', kind: 'Service' }
    ])
  })

  it('ignores nested apiVersion-like keys', () => {
    const m = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers: []'
    expect(parseManifestRefs(m)).toEqual([{ apiVersion: 'apps/v1', kind: 'Deployment' }])
  })

  it('handles quoted apiVersions, which charts emit', () => {
    const m = 'apiVersion: "apps/v1"\nkind: Deployment\n---\napiVersion: \'v1\'\nkind: Service'
    expect(parseManifestRefs(m)).toEqual([
      { apiVersion: 'apps/v1', kind: 'Deployment' },
      { apiVersion: 'v1', kind: 'Service' }
    ])
  })

  it('returns nothing for a doc without both keys', () => {
    expect(parseManifestRefs('foo: bar\nkind: Thing')).toEqual([])
  })
})

describe('compareVersions', () => {
  it('ranks GA above beta above alpha, then by number', () => {
    const sorted = ['v1beta1', 'v2', 'v1alpha1', 'v1', 'v1beta2'].sort(compareVersions)
    expect(sorted).toEqual(['v2', 'v1', 'v1beta2', 'v1beta1', 'v1alpha1'])
  })
})

describe('scanApiVersions', () => {
  it('passes anything the cluster still serves', () => {
    const refs = parseManifestRefs('apiVersion: apps/v1\nkind: Deployment')
    expect(scanApiVersions(refs, SERVED)).toEqual([])
  })

  it('flags a removed version and offers the served ones, newest first', () => {
    const refs = [{ apiVersion: 'autoscaling/v2beta1', kind: 'HorizontalPodAutoscaler' }]
    const [f] = scanApiVersions(refs, SERVED)
    expect(f.apiVersion).toBe('autoscaling/v2beta1')
    expect(f.alternatives).toEqual(['autoscaling/v2', 'autoscaling/v1'])
    expect(f.groupMissing).toBe(false)
  })

  it('marks a group that is gone entirely', () => {
    const refs = [{ apiVersion: 'extensions/v1beta1', kind: 'Ingress' }]
    const [f] = scanApiVersions(refs, SERVED)
    expect(f.groupMissing).toBe(true)
    expect(f.alternatives).toEqual([])
  })

  it('catches CRD versions a static deprecation table would miss', () => {
    const refs = [{ apiVersion: 'gateway.networking.k8s.io/v1alpha2', kind: 'HTTPRoute' }]
    const [f] = scanApiVersions(refs, SERVED)
    expect(f.alternatives).toEqual([
      'gateway.networking.k8s.io/v1',
      'gateway.networking.k8s.io/v1beta1'
    ])
  })

  it('handles the core group', () => {
    const refs = [{ apiVersion: 'v1beta1', kind: 'Thing' }]
    expect(scanApiVersions(refs, SERVED)[0].alternatives).toEqual(['v1'])
  })
})
