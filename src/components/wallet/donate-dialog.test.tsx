import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DonateDialog } from './donate-dialog'

afterEach(cleanup)

function setup(balance = 2000) {
  const onDonate = vi.fn()
  render(<DonateDialog open onOpenChange={() => {}} balanceCents={balance} onDonate={onDonate} />)
  const type = (v: string) => fireEvent.change(screen.getByLabelText('Donation amount in dollars'), { target: { value: v } })
  const btn = () => screen.getByRole('button', { name: 'Donate' }) as HTMLButtonElement
  return { onDonate, type, btn }
}

describe('DonateDialog', () => {
  it('shows disclaimers and no logo', () => {
    setup()
    expect(screen.getByText('Mock donation: no money moves.')).toBeTruthy()
    expect(screen.getByText('Not affiliated with or endorsed by CNCF')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })
  it('accepts 1 cent', () => {
    const { onDonate, type, btn } = setup()
    type('0.01')
    fireEvent.click(btn())
    expect(onDonate).toHaveBeenCalledWith(1)
  })
  it('accepts the full balance', () => {
    const { onDonate, type, btn } = setup()
    type('20.00')
    fireEvent.click(btn())
    expect(onDonate).toHaveBeenCalledWith(2000)
  })
  it('rejects 0 and over balance', () => {
    const { onDonate, type, btn } = setup()
    type('0')
    expect(btn().disabled).toBe(true)
    type('20.01')
    expect(btn().disabled).toBe(true)
    fireEvent.click(btn())
    expect(onDonate).not.toHaveBeenCalled()
  })
})
