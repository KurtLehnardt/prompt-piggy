import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { StrikeScene } from './strike-scene'
import type { AttemptOutcome } from '@/types/api'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mockMatchMedia(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }))
}

const scene = () => screen.getByTestId('strike-scene')

describe('StrikeScene', () => {
  it('swings once per strikeKey change and not on mount', () => {
    mockMatchMedia(false)
    const { rerender } = render(<StrikeScene strikeKey="a" outcome={null} />)
    expect(scene().dataset.swings).toBe('0')
    rerender(<StrikeScene strikeKey="b" outcome="fail" />)
    expect(scene().dataset.swings).toBe('1')
    rerender(<StrikeScene strikeKey="b" outcome="fail" />)
    expect(scene().dataset.swings).toBe('1')
    rerender(<StrikeScene strikeKey="c" outcome="win" />)
    expect(scene().dataset.swings).toBe('2')
  })
  it.each(['win', 'late_win', 'fail', 'blocked', 'leak_blocked', 'error'] as AttemptOutcome[])('maps %s to a pig reaction', (o) => {
    mockMatchMedia(false)
    render(<StrikeScene strikeKey={1} outcome={o} />)
    expect(scene().dataset.reaction).toBe(o)
  })
  it('changes state without motion under reduced motion', () => {
    mockMatchMedia(true)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { rerender } = render(<StrikeScene strikeKey="a" outcome={null} />)
    rerender(<StrikeScene strikeKey="b" outcome="win" />)
    expect(scene().dataset.swings).toBe('1')
    expect(scene().dataset.reaction).toBe('win')
    expect(raf).not.toHaveBeenCalled()
  })
})
