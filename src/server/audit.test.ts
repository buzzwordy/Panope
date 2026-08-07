import { describe, it, expect } from 'vitest'
import { describeTarget } from './audit'

describe('describeTarget', () => {
  it('summarises resource mutations as "key ns/name"', () => {
    expect(describeTarget('deleteResource', ['pods', 'api-1', 'prod'])).toBe('pods prod/api-1')
    expect(describeTarget('restartResource', ['deployments', 'api', 'prod'])).toBe('deployments prod/api')
    expect(describeTarget('deleteResource', ['nodes', 'worker-1', undefined])).toBe('nodes worker-1')
  })

  it('includes the replica target for scale', () => {
    expect(describeTarget('scaleResource', ['deployments', 'api', 'prod', 5])).toBe('deployments prod/api -> 5')
  })

  it('summarises custom deletions with group', () => {
    expect(describeTarget('deleteCustom', [{ plural: 'applications', group: 'argoproj.io' }, 'shop', 'argocd'])).toBe(
      'applications.argoproj.io argocd/shop'
    )
  })

  it('summarises helm deploys from the spec object', () => {
    expect(
      describeTarget('helmInstall', [{ release: 'redis', chart: 'bitnami/redis', namespace: 'data', version: '19.0.1' }])
    ).toBe('bitnami/redis@19.0.1 as data/redis')
    expect(describeTarget('helmUpgrade', [{ release: 'redis', chart: 'bitnami/redis', namespace: 'data' }])).toBe(
      'bitnami/redis as data/redis'
    )
  })

  it('summarises argo + pod-file writes (ns-first argument orders)', () => {
    expect(describeTarget('argoSync', ['argocd', 'shop'])).toBe('argocd/shop')
    expect(describeTarget('podWriteFile', ['prod', 'api-1', 'app', '/tmp/x.txt', 'AAAA'])).toBe('prod/api-1:/tmp/x.txt')
  })

  it('falls back to the method name for unknown methods', () => {
    expect(describeTarget('somethingNew', [])).toBe('somethingNew')
  })
})
