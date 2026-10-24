'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/** Placeholder rails. No network calls, no SDKs, no URLs (CH-4). */
export function ComingSoonMenu({ label }: { label: 'Add funds' | 'Withdraw' }) {
  const [open, setOpen] = useState(false)
  const choose = (rail: string) => {
    toast(`${rail} is coming soon`)
    setOpen(false)
  }
  return (
    <div>
      <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open ? (
        <div role="menu" aria-label={`${label} options`} className="mt-1 flex flex-col gap-1">
          <Button type="button" role="menuitem" variant="ghost" size="sm" onClick={() => choose('Card (Stripe)')}>
            Card (Stripe)
          </Button>
          <Button type="button" role="menuitem" variant="ghost" size="sm" onClick={() => choose('Crypto (Lightning)')}>
            Crypto (Lightning)
          </Button>
        </div>
      ) : null}
    </div>
  )
}
