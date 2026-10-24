import { describe, expect, it } from 'vitest'
import { glowFor, shouldPulse } from './glow'

describe('glowFor', () => {
  it('has no glow at 0', () => {
    expect(glowFor(0)).toEqual({ spreadPx: 0, blurPx: 0, opacity: 0 })
  })
  it('maps full aura', () => {
    expect(glowFor(10000)).toEqual({ spreadPx: 4, blurPx: 6, opacity: 1 })
  })
  it('never exceeds 10px and never decreases', () => {
    let prev = glowFor(0)
    for (let b = 0; b <= 10000; b++) {
      const g = glowFor(b)
      expect(g.spreadPx + g.blurPx).toBeLessThanOrEqual(10)
      expect(g.spreadPx).toBeGreaterThanOrEqual(prev.spreadPx)
      expect(g.blurPx).toBeGreaterThanOrEqual(prev.blurPx)
      expect(g.opacity).toBeGreaterThanOrEqual(prev.opacity)
      prev = g
    }
  })
  it('clamps junk', () => {
    expect(glowFor(-5).opacity).toBe(0)
    expect(glowFor(99999)).toEqual(glowFor(10000))
    expect(glowFor(NaN).opacity).toBe(0)
  })
  it('pulses at 0.5 and above only', () => {
    expect(shouldPulse(4999)).toBe(false)
    expect(shouldPulse(5000)).toBe(true)
  })
})
