import { describe, expect, it } from 'vitest'
import { compareVersions } from './update'

describe('compareVersions', () => {
  it('orders release versions', () => {
    expect(compareVersions('2.7.1', '2.7.0')).toBe(1)
    expect(compareVersions('2.7.0', '2.7.1')).toBe(-1)
    expect(compareVersions('2.7.0', '2.7.0')).toBe(0)
    expect(compareVersions('3.0.0', '2.99.99')).toBe(1)
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1)
  })

  it('ignores a leading v', () => {
    expect(compareVersions('v2.8.0', '2.7.0')).toBe(1)
    expect(compareVersions('v2.7.0', 'v2.7.0')).toBe(0)
  })

  it('treats a prerelease as older than its release', () => {
    expect(compareVersions('2.7.0', '2.7.0-rc.1')).toBe(1)
    expect(compareVersions('2.7.0-rc.1', '2.7.0')).toBe(-1)
    expect(compareVersions('2.7.0-rc.2', '2.7.0-rc.1')).toBe(1)
  })

  it('reports equal for garbage rather than claiming an update', () => {
    expect(compareVersions('nightly', '2.7.0')).toBe(0)
    expect(compareVersions('2.7.0', '')).toBe(0)
  })
})
