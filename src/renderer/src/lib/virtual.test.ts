import { describe, it, expect } from 'vitest'
import { computeWindow } from './virtual'

describe('computeWindow', () => {
  it('starts at 0 with no scroll (overscan clamps)', () => {
    const w = computeWindow(0, 900, 30, 10000)
    expect(w.start).toBe(0)
    expect(w.topPad).toBe(0)
    expect(w.end).toBeGreaterThanOrEqual(30) // viewport rows + overscan
  })
  it('windows into the middle on scroll', () => {
    const w = computeWindow(30 * 500, 900, 30, 10000, 12)
    expect(w.start).toBe(500 - 12)
    expect(w.topPad).toBe((500 - 12) * 30)
    expect(w.end).toBe(w.start + Math.ceil(900 / 30) + 24)
    expect(w.bottomPad).toBe((10000 - w.end) * 30)
  })
  it('clamps the end to total', () => {
    const w = computeWindow(30 * 9990, 900, 30, 10000)
    expect(w.end).toBe(10000)
    expect(w.bottomPad).toBe(0)
  })
  it('handles totals smaller than the viewport', () => {
    const w = computeWindow(0, 900, 30, 5)
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
    expect(w.topPad).toBe(0)
    expect(w.bottomPad).toBe(0)
  })
  it('tolerates negative scrollTop and zero row height', () => {
    const w = computeWindow(-50, 900, 0, 100)
    expect(w.start).toBe(0)
    expect(w.end).toBeGreaterThan(0)
  })
})
