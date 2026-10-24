import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('joins class names and drops falsy values', () => {
    expect(cn('a', false, null, undefined, 'b', { c: true, d: false })).toBe('a b c')
  })

  it('lets the last conflicting Tailwind utility win', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })
})
