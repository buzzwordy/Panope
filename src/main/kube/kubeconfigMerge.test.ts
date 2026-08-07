import { describe, it, expect } from 'vitest'
import { mergeKubeconfigs, type RawKubeconfig } from './kubeconfigMerge'

/**
 * The merge follows kubectl: reading several files, the FIRST to define a name
 * wins and later definitions are ignored. Getting this wrong either loses
 * contexts silently or - if you lean on the client library's mergeConfig,
 * which throws on any duplicate name - takes out every file after a collision.
 */
const A: RawKubeconfig = {
  clusters: [{ name: 'shared', server: 'https://a' }],
  users: [{ name: 'me', token: 'a' }],
  contexts: [
    { name: 'prod', cluster: 'shared', user: 'me' },
    { name: 'staging', cluster: 'shared', user: 'me' }
  ],
  currentContext: 'prod'
}

const B: RawKubeconfig = {
  // deliberately reuses "shared" and "prod" - routine across unrelated files
  clusters: [{ name: 'shared', server: 'https://b' }, { name: 'edge', server: 'https://edge' }],
  users: [{ name: 'me', token: 'b' }, { name: 'edge-user', token: 'e' }],
  contexts: [
    { name: 'prod', cluster: 'edge', user: 'edge-user' },
    { name: 'edge', cluster: 'edge', user: 'edge-user' }
  ],
  currentContext: 'edge'
}

describe('mergeKubeconfigs', () => {
  it('unions contexts across files', () => {
    const m = mergeKubeconfigs([
      { path: '/a', isDefault: true, config: A },
      { path: '/b', isDefault: false, config: B }
    ])
    expect(m.contexts.map((c) => c.name).sort()).toEqual(['edge', 'prod', 'staging'])
  })

  it('resolves collisions in favour of the earlier file', () => {
    const m = mergeKubeconfigs([
      { path: '/a', isDefault: true, config: A },
      { path: '/b', isDefault: false, config: B }
    ])
    // "prod" and "shared" came from A, so B's versions must not win
    expect(m.contexts.find((c) => c.name === 'prod')?.cluster).toBe('shared')
    expect(m.clusters.find((c) => c.name === 'shared')?.server).toBe('https://a')
    expect(m.users.find((u) => u.name === 'me')?.token).toBe('a')
  })

  it('reports what each file contributed and what was shadowed', () => {
    const m = mergeKubeconfigs([
      { path: '/a', isDefault: true, config: A },
      { path: '/b', isDefault: false, config: B }
    ])
    const [a, b] = m.report
    expect(a.contexts).toEqual(['prod', 'staging'])
    expect(a.shadowed).toEqual([])
    expect(b.contexts).toEqual(['edge'])
    expect(b.shadowed).toEqual(['prod'])
  })

  it('takes the current context from the first file that names one', () => {
    expect(
      mergeKubeconfigs([
        { path: '/a', isDefault: true, config: A },
        { path: '/b', isDefault: false, config: B }
      ]).currentContext
    ).toBe('prod')
    expect(
      mergeKubeconfigs([
        { path: '/b', isDefault: false, config: B },
        { path: '/a', isDefault: true, config: A }
      ]).currentContext
    ).toBe('edge')
  })

  it('keeps going when a file failed to load, and records why', () => {
    const m = mergeKubeconfigs([
      { path: '/gone', isDefault: false, error: 'ENOENT' },
      { path: '/a', isDefault: true, config: A }
    ])
    expect(m.contexts.map((c) => c.name)).toEqual(['prod', 'staging'])
    expect(m.report[0]).toMatchObject({ ok: false, error: 'ENOENT', contexts: [] })
    expect(m.report[1].ok).toBe(true)
  })

  it('attributes every context to the file it came from', () => {
    const m = mergeKubeconfigs([
      { path: '/a', isDefault: true, config: A },
      { path: '/b', isDefault: false, config: B }
    ])
    expect(m.source.get('prod')).toBe('/a')
    expect(m.source.get('edge')).toBe('/b')
  })

  it('handles an empty list without throwing', () => {
    const m = mergeKubeconfigs([])
    expect(m.contexts).toEqual([])
    expect(m.currentContext).toBe('')
  })
})
