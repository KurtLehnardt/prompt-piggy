'use client'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatCents } from '@/lib/money/format'
import { RepairButton, type RepairButtonProps } from './repair-button'

export type ShatterDialogProps = {
  open: boolean
  /** Dismiss: play continues with cracks shown. */
  onDismiss: () => void
  /** Server config price. */
  repairPriceCents: number
  onRepair: RepairButtonProps['onRepair']
  onStale: RepairButtonProps['onStale']
}

export function ShatterDialog({ open, onDismiss, repairPriceCents, onRepair, onStale }: ShatterDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>The glass shattered!</DialogTitle>
          <DialogDescription>
            Repair it for {formatCents(repairPriceCents)}, or keep playing with the cracks showing.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <RepairButton cracks={3} priceCents={repairPriceCents} onRepair={onRepair} onStale={onStale} />
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            Keep playing
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
