import { describe, expect, it } from 'vitest'
import { assertCents, formatCents, parseDollarsToCents } from '@/lib/money/format'

/** Integer cents to US dollars (CH-1). */

describe('formatCents', () => {
  it.each([
    [100, '$1.00'],
    [5, '$0.05'],
    [2000, '$20.00'],
    [0, '$0.00'],
    [1, '$0.01'],
    [99, '$0.99'],
    [40, '$0.40'],
    [123456, '$1,234.56'],
    [100000000, '$1,000,000.00'],
    [-40, '-$0.40'],
    [-2000, '-$20.00'],
    [Number.MAX_SAFE_INTEGER, '$90,071,992,547,409.91'],
  ])('%s cents is %s', (cents, expected) => {
    expect(formatCents(cents)).toBe(expected)
  })

  it.each([1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (value) => {
      expect(() => formatCents(value)).toThrow(TypeError)
      expect(() => assertCents(value)).toThrow('Money amounts must be integer cents.')
    }
  )

  it('normalizes -0 to $0.00', () => {
    expect(formatCents(-0)).toBe('$0.00')
  })
})

describe('parseDollarsToCents', () => {
  it.each([
    ['1', 100],
    ['1.00', 100],
    ['0.05', 5],
    ['0.5', 50],
    ['$20', 2000],
    ['  $0.01 ', 1],
    ['20.10', 2010],
    ['999999999.99', 99999999999],
  ])('%s is %s cents', (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents)
  })

  it.each(['', ' ', 'abc', '-1', '1.234', '1,000', '.50', '1.', '$', '1e3', '0x10', '1000000000'])(
    'rejects %j',
    (input) => {
      expect(parseDollarsToCents(input)).toBeNull()
    }
  )
})
