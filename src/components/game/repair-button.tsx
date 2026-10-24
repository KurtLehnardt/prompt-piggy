'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatCents } from '@/lib/money/format'
import type { CrackCount } from '@/types/api'

export type RepairOutcome = 'repaired' | 'nothing_to_repair'

export type RepairButtonProps = {
  /** Server crack count; the button is absent at 0. */
  cracks: CrackCount
  /** Server price in cents. */
  priceCents: number
  /** Wiring performs the call and reports the result. */
  onRepair: () => Promise<RepairOutcome | void>
  /** Called instead of showing an error when the server says nothing_to_repair. */
  onStale: () => void
}

export function RepairButton({ cracks, priceCents, onRepair, onStale }: RepairButtonProps) {
  const [pending, setPending] = useState(false)
  if (cracks < 1) return null

  async function click() {
    if (pending) return
    setPending(true)
    try {
      const result = await onRepair()
      if (result === 'nothing_to_repair') onStale()
    } finally {
      setPending(false)
    }
  }

  return (
    <Button type="button" size="sm" disabled={pending} onClick={click} data-testid="repair-button">
      {pending ? 'Repairing...' : `Repair glass (${formatCents(priceCents)})`}
    </Button>
  )
}
