'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatCents, parseDollarsToCents } from '@/lib/money/format'

export type DonateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  balanceCents: number
  onDonate: (amountCents: number) => void
}

export function DonateDialog({ open, onOpenChange, balanceCents, onDonate }: DonateDialogProps) {
  const [text, setText] = useState('')
  const cents = parseDollarsToCents(text)
  const valid = cents !== null && cents >= 1 && cents <= balanceCents
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Donate to CNCF</DialogTitle>
          <DialogDescription>Mock donation: no money moves.</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Not affiliated with or endorsed by CNCF</p>
        <label className="flex flex-col gap-1 text-sm">
          Amount (max {formatCents(balanceCents)})
          <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0.01" aria-label="Donation amount in dollars" />
        </label>
        <Button type="button" disabled={!valid} onClick={() => valid && onDonate(cents)}>
          Donate
        </Button>
      </DialogContent>
    </Dialog>
  )
}
