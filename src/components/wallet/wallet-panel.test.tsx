import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const toast = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast }))

import { WalletPanel } from './wallet-panel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  toast.mockClear()
})

describe('WalletPanel', () => {
  it('shows server balance and avatar', () => {
    render(<WalletPanel name="Ada Lovelace" avatarUrl={null} auraBps={5000} balanceCents={1999} onDonateClick={() => {}} />)
    expect(screen.getByTestId('balance').textContent).toBe('$19.99')
    expect(screen.getByTestId('avatar-glow')).toBeTruthy()
  })
  it('all four rails toast Coming soon with zero network calls', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(<WalletPanel name="A" avatarUrl={null} auraBps={0} balanceCents={2000} onDonateClick={() => {}} />)
    for (const label of ['Add funds', 'Withdraw']) {
      for (const rail of ['Card (Stripe)', 'Crypto (Lightning)']) {
        fireEvent.click(screen.getByRole('button', { name: label }))
        fireEvent.click(screen.getByRole('menuitem', { name: rail }))
      }
    }
    expect(toast).toHaveBeenCalledTimes(4)
    expect(toast.mock.calls.every((c) => /coming soon/i.test(String(c[0])))).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('imports no payment code', () => {
    for (const f of ['wallet-panel.tsx', 'coming-soon-menu.tsx', 'donate-dialog.tsx']) {
      const src = readFileSync(join(process.cwd(), 'src/components/wallet', f), 'utf8')
      expect(src).not.toMatch(/lib\/payments|stripe\.com|js\.stripe|lightning:|from ['"]stripe/i)
    }
  })
  it('calls onDonateClick', () => {
    const fn = vi.fn()
    render(<WalletPanel name="A" avatarUrl={null} auraBps={0} balanceCents={2000} onDonateClick={fn} />)
    fireEvent.click(screen.getByRole('button', { name: 'Donate to CNCF' }))
    expect(fn).toHaveBeenCalled()
  })
})
