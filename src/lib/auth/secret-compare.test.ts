import { describe, expect, it } from 'vitest'
import { safeEqual } from './secret-compare'

/** docs/ARCHITECTURE.md section 11, T22; PR #6 review, M1 (fail closed on an empty secret). */
// Low-entropy test values only: the repository is public and gitleaks scans every file.
const SECRET = 's'.repeat(32)

describe('safeEqual', () => {
  it('matches an identical value', () => {
    expect(safeEqual(SECRET, SECRET)).toBe(true)
    expect(safeEqual(`Bearer ${SECRET}`, `Bearer ${SECRET}`)).toBe(true)
  })

  it('matches identical multibyte values', () => {
    expect(safeEqual('pïg-🐷-secret', 'pïg-🐷-secret')).toBe(true)
  })

  it.each([
    ['a different value of the same length', `${SECRET.slice(0, -1)}t`],
    ['a prefix', SECRET.slice(0, -1)],
    ['a longer value', `${SECRET}x`],
    ['a different case', SECRET.toUpperCase()],
    ['the same value with a different first byte', `t${SECRET.slice(1)}`],
    ['surrounding whitespace', ` ${SECRET} `],
  ])('rejects %s', (_label, presented) => {
    expect(safeEqual(presented, SECRET)).toBe(false)
  })

  it('compares byte lengths, so a multibyte value with the same string length never throws', () => {
    // "é" is one UTF-16 code unit but two UTF-8 bytes.
    const sameCodeUnits = `${SECRET.slice(0, -1)}é`
    expect(sameCodeUnits.length).toBe(SECRET.length)
    expect(() => safeEqual(sameCodeUnits, SECRET)).not.toThrow()
    expect(safeEqual(sameCodeUnits, SECRET)).toBe(false)
    expect(safeEqual('🐷'.repeat(16), SECRET)).toBe(false)
  })

  it('never matches an empty or missing expected value', () => {
    expect(safeEqual('', '')).toBe(false)
    expect(safeEqual('anything', '')).toBe(false)
    expect(safeEqual('', SECRET)).toBe(false)
    expect(safeEqual(undefined, undefined)).toBe(false)
    expect(safeEqual(null, null)).toBe(false)
    expect(safeEqual(SECRET, undefined)).toBe(false)
    expect(safeEqual(undefined, SECRET)).toBe(false)
  })

  it('returns false for values that are not strings, without throwing', () => {
    for (const value of [null, undefined, 42, {}, [], Buffer.from(SECRET), Symbol('x')]) {
      expect(() => safeEqual(value, SECRET)).not.toThrow()
      expect(safeEqual(value, SECRET)).toBe(false)
    }
  })
})
