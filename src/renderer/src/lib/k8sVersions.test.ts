import { describe, expect, it } from 'vitest'
import { minorOf, versionSupport, supportLabel, patchOf, patchesBehind } from './k8sVersions'

const on = (d: string) => new Date(`${d}T12:00:00Z`)

describe('minorOf', () => {
  it('handles the shapes distributions actually emit', () => {
    expect(minorOf('v1.33.13+k3s1')).toBe('1.33')
    expect(minorOf('v1.29.4-eks-a1b2c3')).toBe('1.29')
    expect(minorOf('1.30.0')).toBe('1.30')
    expect(minorOf(undefined)).toBeNull()
    expect(minorOf('not-a-version')).toBeNull()
  })
})

describe('versionSupport', () => {
  it('flags a minor whose patch window has closed', () => {
    const v = versionSupport('v1.33.13+k3s1', on('2026-09-17'))!
    expect(v.state).toBe('eol')
    expect(v.minor).toBe('1.33')
    expect(v.days).toBeLessThan(0)
  })

  it('warns a quarter ahead', () => {
    const v = versionSupport('v1.34.1', on('2026-09-17'))!
    expect(v.state).toBe('ending')
    expect(v.days).toBeGreaterThan(0)
    expect(v.days).toBeLessThanOrEqual(90)
  })

  it('stays quiet while there is plenty of runway', () => {
    expect(versionSupport('v1.35.0', on('2026-09-17'))!.state).toBe('supported')
  })

  it('says unknown for a minor newer than the table, rather than guessing', () => {
    const v = versionSupport('v1.99.0', on('2026-09-17'))!
    expect(v.state).toBe('unknown')
    expect(v.eol).toBeUndefined()
    expect(supportLabel(v)).toContain('No support data')
  })

  it('returns null when there is no version at all', () => {
    expect(versionSupport(undefined)).toBeNull()
  })
})

describe('patch currency', () => {
  it('reads the patch number through distro suffixes', () => {
    expect(patchOf('v1.33.13+k3s1')).toBe(13)
    expect(patchOf('v1.29.4-eks-a1b2c3')).toBe(4)
    expect(patchOf('nonsense')).toBeNull()
  })

  it('counts patches behind within the same minor', () => {
    expect(patchesBehind('v1.33.2+k3s1', 'v1.33.13')).toBe(11)
    expect(patchesBehind('v1.33.13+k3s1', 'v1.33.13')).toBe(0)
  })

  it('never compares across different minors', () => {
    expect(patchesBehind('v1.32.9', 'v1.33.13')).toBeNull()
  })

  it('clamps rather than reporting a negative when ahead of the feed', () => {
    expect(patchesBehind('v1.33.20', 'v1.33.13')).toBe(0)
  })

  it('returns null on unparseable input', () => {
    expect(patchesBehind(undefined, 'v1.33.13')).toBeNull()
    expect(patchesBehind('v1.33.1', undefined)).toBeNull()
  })
})
