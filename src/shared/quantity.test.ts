import { describe, it, expect } from 'vitest'
import { parseCpuToMillicores, parseMemoryToBytes } from './quantity'

describe('parseCpuToMillicores', () => {
  it('parses millicores', () => {
    expect(parseCpuToMillicores('100m')).toBe(100)
    expect(parseCpuToMillicores('1500m')).toBe(1500)
  })
  it('parses whole cores', () => {
    expect(parseCpuToMillicores('2')).toBe(2000)
    expect(parseCpuToMillicores('0.5')).toBe(500)
  })
  it('parses nano and micro cores', () => {
    expect(parseCpuToMillicores('250000000n')).toBe(250)
    expect(parseCpuToMillicores('1500u')).toBeCloseTo(1.5)
    expect(parseCpuToMillicores('1500µ')).toBeCloseTo(1.5)
  })
  it('treats a bare number as cores', () => {
    expect(parseCpuToMillicores(2)).toBe(2000)
  })
  it('is forgiving of empty / bad input', () => {
    expect(parseCpuToMillicores(undefined)).toBe(0)
    expect(parseCpuToMillicores('')).toBe(0)
    expect(parseCpuToMillicores('abc')).toBe(0)
  })
})

describe('parseMemoryToBytes', () => {
  it('parses binary suffixes', () => {
    expect(parseMemoryToBytes('1Ki')).toBe(1024)
    expect(parseMemoryToBytes('128Mi')).toBe(128 * 2 ** 20)
    expect(parseMemoryToBytes('1Gi')).toBe(2 ** 30)
  })
  it('parses decimal suffixes', () => {
    expect(parseMemoryToBytes('500M')).toBe(500e6)
    expect(parseMemoryToBytes('1k')).toBe(1000)
  })
  it('parses a bare byte count', () => {
    expect(parseMemoryToBytes('1000000')).toBe(1000000)
    expect(parseMemoryToBytes(2048)).toBe(2048)
  })
  it('is forgiving of empty / bad input', () => {
    expect(parseMemoryToBytes(undefined)).toBe(0)
    expect(parseMemoryToBytes('')).toBe(0)
    expect(parseMemoryToBytes('nope')).toBe(0)
  })
})
