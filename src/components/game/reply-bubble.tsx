import { outcomeMessage } from '@/lib/game/api-client'
import { cn } from '@/lib/utils'
import type { AttemptResultDTO } from '@/types/api'

/**
 * The pig's answer to the latest attack (docs/ARCHITECTURE.md section 7). The
 * reply is rendered as plain text only: React escapes it, and nothing here
 * ever parses or injects HTML. The note below it comes from server fields
 * (outcome, payout, refund) and is never computed in the browser (HC-A5).
 */
export type ReplyBubbleProps = {
  attempt: Pick<AttemptResultDTO, 'outcome' | 'reply' | 'payoutCents' | 'refundCents' | 'refundWithheld' | 'priceCents'>
  className?: string
}

const TONE: Record<AttemptResultDTO['outcome'], string> = {
  win: 'border-emerald-500/60 bg-emerald-500/10',
  late_win: 'border-amber-500/60 bg-amber-500/10',
  fail: 'border-border bg-muted/40',
  blocked: 'border-border bg-muted/40',
  leak_blocked: 'border-border bg-muted/40',
  error: 'border-destructive/50 bg-destructive/10',
}

export function ReplyBubble({ attempt, className }: ReplyBubbleProps) {
  return (
    <section
      aria-label="The pig's reply"
      aria-live="polite"
      className={cn('flex flex-col gap-2 rounded-xl border p-4', TONE[attempt.outcome], className)}
      data-testid="reply-bubble"
      data-outcome={attempt.outcome}
    >
      {attempt.reply ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="reply-text">
          <span aria-hidden="true">🐷 </span>
          {attempt.reply}
        </p>
      ) : null}
      <p className="text-sm font-medium" data-testid="outcome-note">
        {outcomeMessage(attempt)}
      </p>
    </section>
  )
}
