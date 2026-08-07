import { describe, it, expect } from 'vitest'
import { diffLines, diffStat } from './lineDiff'

describe('diffLines', () => {
  it('marks identical text as all-same', () => {
    const rows = diffLines('a\nb\nc', 'a\nb\nc')
    expect(rows.every((r) => r.kind === 'same')).toBe(true)
    expect(diffStat(rows)).toEqual({ added: 0, removed: 0 })
  })
  it('detects a changed line as a del + add pair', () => {
    const rows = diffLines('a\nb\nc', 'a\nB\nc')
    expect(diffStat(rows)).toEqual({ added: 1, removed: 1 })
    const changed = rows.filter((r) => r.kind !== 'same')
    expect(changed.map((r) => [r.kind, r.text])).toEqual([
      ['del', 'b'],
      ['add', 'B']
    ])
  })
  it('detects a pure addition', () => {
    const rows = diffLines('a\nb', 'a\nb\nc')
    expect(diffStat(rows)).toEqual({ added: 1, removed: 0 })
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'add', text: 'c', newNo: 3 })
  })
  it('detects a pure deletion', () => {
    const rows = diffLines('a\nb\nc', 'a\nc')
    expect(diffStat(rows)).toEqual({ added: 0, removed: 1 })
    expect(rows.find((r) => r.kind === 'del')).toMatchObject({ text: 'b', oldNo: 2 })
  })
  it('tracks old/new line numbers on same rows', () => {
    const rows = diffLines('a\nb', 'a\nb')
    expect(rows[0]).toMatchObject({ oldNo: 1, newNo: 1 })
    expect(rows[1]).toMatchObject({ oldNo: 2, newNo: 2 })
  })
})
