import { describe, expect, it } from 'vitest'
import { dampingForRatio, isSettled, MAX_DT, stepSpring, type SpringState } from './spring'

const K = 200

function run(ratio: number, dt: number, steps: number, target = 1) {
  let s: SpringState = { x: 0, v: 0 }
  let max = 0
  for (let i = 0; i < steps; i++) {
    s = stepSpring(s, target, { stiffness: K, damping: dampingForRatio(K, ratio) }, dt)
    max = Math.max(max, s.x)
  }
  return { s, max }
}

describe('spring', () => {
  it('converges to the target', () => {
    const { s } = run(0.7, 1 / 60, 600)
    expect(isSettled(s, 1)).toBe(true)
  })

  it('stays finite under dt spikes (clamped to 1/30 s)', () => {
    let s: SpringState = { x: 0, v: 0 }
    for (const dt of [10, 1e9, Infinity, NaN, -5, 0.5]) {
      s = stepSpring(s, 1, { stiffness: K, damping: dampingForRatio(K, 0.5) }, dt)
      expect(Number.isFinite(s.x)).toBe(true)
      expect(Number.isFinite(s.v)).toBe(true)
    }
    const huge = stepSpring({ x: 0, v: 0 }, 1, { stiffness: K, damping: 10 }, 100)
    const clamped = stepSpring({ x: 0, v: 0 }, 1, { stiffness: K, damping: 10 }, MAX_DT)
    expect(huge).toEqual(clamped)
  })

  it('keeps overshoot bounded for damping ratios >= 0.5', () => {
    for (const ratio of [0.5, 0.7, 1, 2]) {
      const { max } = run(ratio, 1 / 60, 600)
      expect(max).toBeLessThan(1.25)
    }
    expect(run(1, 1 / 60, 600).max).toBeLessThanOrEqual(1.001)
  })
})
