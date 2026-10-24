import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TreasuryCounter } from './treasury-counter'

/** The animated treasury counter (ARCHITECTURE section 12.2; CH-1). */

function shownText(): string {
  return screen.getByTestId('treasury-counter').querySelector('[aria-hidden="true"]')?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TreasuryCounter', () => {
  it('shows integer cents as dollars through money/format.ts', () => {
    render(<TreasuryCounter cents={123_456} />)
    expect(shownText()).toBe('$1,234.56')
    expect(screen.getByText('$1,234.56', { selector: '.sr-only' })).toBeTruthy()
  })

  it('animates to a new amount, showing only whole cents on the way, and settles on the exact value', async () => {
    const { rerender } = render(<TreasuryCounter cents={1_000} />)
    rerender(<TreasuryCounter cents={5_000} />)
    expect(screen.getByText('$50.00', { selector: '.sr-only' })).toBeTruthy()

    const seen = new Set<string>()
    for (let frame = 0; frame < 30; frame += 1) {
      await act(async () => {
        vi.advanceTimersByTime(16)
      })
      seen.add(shownText())
    }
    const midway = [...seen].filter((text) => text !== '$10.00' && text !== '$50.00')
    expect(midway.length).toBeGreaterThan(0)
    for (const text of seen) expect(text).toMatch(/^\$\d{1,3}(,\d{3})*\.\d{2}$/)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(shownText()).toBe('$50.00')
    expect(screen.getByTestId('treasury-counter').dataset.cents).toBe('5000')
  })

  it('jumps without animation when reduced motion is preferred', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }))
    const { rerender } = render(<TreasuryCounter cents={100} />)
    rerender(<TreasuryCounter cents={250} />)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(shownText()).toBe('$2.50')
  })

  it('treats a non-integer amount as zero instead of rounding money', () => {
    render(<TreasuryCounter cents={12.5} />)
    expect(shownText()).toBe('$0.00')
  })
})
