import { AvatarGlow } from '@/components/player/avatar-glow'
import { Button } from '@/components/ui/button'
import { formatCents } from '@/lib/money/format'
import { ComingSoonMenu } from './coming-soon-menu'

export type WalletPanelProps = {
  name: string
  avatarUrl: string | null
  /** Server values; nothing is computed here. */
  auraBps: number
  balanceCents: number
  onDonateClick: () => void
}

export function WalletPanel({ name, avatarUrl, auraBps, balanceCents, onDonateClick }: WalletPanelProps) {
  return (
    <section aria-label="Wallet" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <AvatarGlow name={name} avatarUrl={avatarUrl} auraBps={auraBps} />
        <div>
          <div className="text-sm text-muted-foreground">{name}</div>
          <div className="text-lg font-semibold" data-testid="balance">
            {formatCents(balanceCents)}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <ComingSoonMenu label="Add funds" />
        <ComingSoonMenu label="Withdraw" />
        <Button type="button" variant="outline" size="sm" onClick={onDonateClick}>
          Donate to CNCF
        </Button>
      </div>
    </section>
  )
}
