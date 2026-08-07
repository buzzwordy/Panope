import { describe, it, expect } from 'vitest'
import { parseAnsi, stripAnsi } from './ansi'

const ESC = '\x1b'

describe('parseAnsi', () => {
  it('returns one plain segment for lines without escapes', () => {
    expect(parseAnsi('hello world')).toEqual([{ text: 'hello world' }])
  })
  it('parses a basic color', () => {
    const segs = parseAnsi(`${ESC}[32mgreen${ESC}[0m plain`)
    expect(segs).toHaveLength(2)
    expect(segs[0].text).toBe('green')
    expect(segs[0].fg).toBeTruthy()
    expect(segs[1]).toEqual({ text: ' plain' })
  })
  it('parses bold + bright colors and resets', () => {
    const segs = parseAnsi(`${ESC}[1;91merror${ESC}[22m still-red${ESC}[39m done`)
    expect(segs[0]).toMatchObject({ text: 'error', bold: true })
    expect(segs[0].fg).toBeTruthy()
    expect(segs[1].bold).toBeUndefined()
    expect(segs[1].fg).toBe(segs[0].fg)
    expect(segs[2].fg).toBeUndefined()
  })
  it('parses 256-color and truecolor', () => {
    const s256 = parseAnsi(`${ESC}[38;5;196mred`)
    expect(s256[0].fg).toBeTruthy()
    const rgb = parseAnsi(`${ESC}[38;2;10;20;30mcustom`)
    expect(rgb[0].fg).toBe('rgb(10,20,30)')
  })
  it('empty SGR params mean reset', () => {
    const segs = parseAnsi(`${ESC}[31mred${ESC}[mplain`)
    expect(segs[1]).toEqual({ text: 'plain' })
  })
  it('strips non-SGR escape sequences', () => {
    const segs = parseAnsi(`${ESC}[2K${ESC}[1Gline`)
    expect(segs).toEqual([{ text: 'line' }])
  })
})

describe('stripAnsi', () => {
  it('removes SGR and other escapes', () => {
    expect(stripAnsi(`${ESC}[32mok${ESC}[0m ${ESC}[2Kx`)).toBe('ok x')
  })
  it('leaves plain text alone', () => {
    expect(stripAnsi('plain')).toBe('plain')
  })
})
