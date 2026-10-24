import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RepairButton } from './repair-button'
import type { CrackCount } from '@/types/api'

afterEach(cleanup)

const props = (cracks: CrackCount) => ({ cracks, priceCents: 100, onRepair: vi.fn(async () => 'repaired' as const), onStale: vi.fn() })

describe('RepairButton', () => {
  it('renders nothing at 0', () => {
    const { container } = render(<RepairButton {...props(0)} />)
    expect(container.innerHTML).toBe('')
  })
  it.each([1, 2, 3] as const)('renders at %i cracks and calls onRepair', async (c) => {
    const p = props(c)
    render(<RepairButton {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Repair glass ($1.00)' }))
    await waitFor(() => expect(p.onRepair).toHaveBeenCalledTimes(1))
    expect(p.onStale).not.toHaveBeenCalled()
  })
  it('shows pending state', async () => {
    let done!: () => void
    const p = { ...props(1), onRepair: vi.fn(() => new Promise<void>((res) => (done = res))) }
    render(<RepairButton {...p} />)
    fireEvent.click(screen.getByRole('button'))
    const b = await screen.findByRole('button', { name: 'Repairing...' })
    expect((b as HTMLButtonElement).disabled).toBe(true)
    done()
    await screen.findByRole('button', { name: 'Repair glass ($1.00)' })
  })
  it('calls onStale on nothing_to_repair', async () => {
    const p = { ...props(2), onRepair: vi.fn(async () => 'nothing_to_repair' as const) }
    render(<RepairButton {...p} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(p.onStale).toHaveBeenCalledTimes(1))
  })
})
