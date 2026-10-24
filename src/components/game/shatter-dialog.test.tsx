import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShatterDialog } from './shatter-dialog'
import { RepairButton } from './repair-button'

afterEach(cleanup)

const base = () => ({ open: true, onDismiss: vi.fn(), repairPriceCents: 100, onRepair: vi.fn(async () => 'repaired' as const), onStale: vi.fn() })

describe('ShatterDialog', () => {
  it('says the glass shattered and repairs', async () => {
    const p = base()
    render(<ShatterDialog {...p} />)
    expect(screen.getByText('The glass shattered!')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Repair glass ($1.00)' }))
    await waitFor(() => expect(p.onRepair).toHaveBeenCalled())
  })
  it('dismisses and the persistent repair button stays visible', () => {
    const p = base()
    const { rerender } = render(
      <>
        <ShatterDialog {...p} />
        <RepairButton cracks={3} priceCents={100} onRepair={p.onRepair} onStale={p.onStale} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Keep playing' }))
    expect(p.onDismiss).toHaveBeenCalled()
    rerender(
      <>
        <ShatterDialog {...p} open={false} />
        <RepairButton cracks={3} priceCents={100} onRepair={p.onRepair} onStale={p.onStale} />
      </>,
    )
    expect(screen.queryByText('The glass shattered!')).toBeNull()
    expect(screen.getByRole('button', { name: 'Repair glass ($1.00)' })).toBeTruthy()
  })
})
