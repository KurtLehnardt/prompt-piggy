import { AvatarGlow } from '@/components/player/avatar-glow'
import { feedEventText, outcomeLabel, outcomeTone, UNKNOWN_PLAYER_LABEL, type OutcomeTone } from '@/components/live/labels'
import { TechniqueBadge } from '@/components/live/technique-badge'
import { formatCents } from '@/lib/money/format'
import { cn } from '@/lib/utils'
import type { LiveFeedItemDTO, LivePlayerDTO } from '@/types/api'

/**
 * The /live feed (docs/ARCHITECTURE.md section 12.2; CH-6; threat T18).
 * Attempt rows show the player's name and avatar, the outcome, the technique
 * label, and the payout for a win. A feed row carries only a pseudonymous
 * player id, resolved through the latest players list; an id that is not on
 * it reads "A player" with no avatar. Level-up and hardening events read as
 * fixed sentences. Nothing here renders a prompt, reply, or email.
 */
export type LiveFeedProps = {
  feed: readonly LiveFeedItemDTO[]
  players: readonly LivePlayerDTO[] | null
  className?: string
}

const TONE_CLASSES: Record<OutcomeTone, string> = {
  win: 'bg-amber-400 text-slate-950',
  neutral: 'bg-white/15',
  blocked: 'bg-rose-500/80',
  error: 'bg-slate-500/60',
}

function payoutOf(item: LiveFeedItemDTO): number | null {
  if (item.outcome !== 'win' && item.outcome !== 'late_win') return null
  return item.amountCents !== null && Number.isSafeInteger(item.amountCents) && item.amountCents > 0 ? item.amountCents : null
}

export function LiveFeed({ feed, players, className }: LiveFeedProps) {
  const byId = new Map((players ?? []).map((player) => [player.id, player]))
  return (
    <section aria-label="Live feed" className={cn('flex min-h-0 flex-col gap-3', className)} data-testid="live-feed">
      <h2 className="text-[32px] font-semibold">Live feed</h2>
      {feed.length === 0 ? (
        <p className="text-[28px] opacity-80">No attacks yet. Be the first!</p>
      ) : (
        <ol className="flex min-h-0 flex-col gap-3 overflow-hidden" aria-live="polite">
          {feed.map((item) => {
            const event = feedEventText(item)
            if (event !== null) {
              return (
                <li key={item.id} className="rounded-xl bg-indigo-500/25 px-5 py-3 text-[28px] font-semibold" data-feed-type={item.type}>
                  {event}
                </li>
              )
            }
            const player = item.playerId ? byId.get(item.playerId) : undefined
            const payout = payoutOf(item)
            return (
              <li key={item.id} className="flex items-center gap-4 rounded-xl bg-white/5 px-5 py-3 text-[28px]" data-feed-type="attempt">
                {player ? (
                  <AvatarGlow name={player.name} avatarUrl={player.avatarUrl} auraBps={player.auraBps} sizePx={56} />
                ) : null}
                <span className="min-w-0 flex-1 truncate font-medium" data-testid="feed-player">
                  {player ? player.name : UNKNOWN_PLAYER_LABEL}
                </span>
                <span className={cn('rounded-full px-4 py-1 whitespace-nowrap', TONE_CLASSES[outcomeTone(item.outcome)])}>
                  {outcomeLabel(item.outcome)}
                </span>
                <TechniqueBadge technique={item.technique} />
                {payout !== null ? (
                  <span className="font-mono font-bold text-amber-300 tabular-nums">+{formatCents(payout)}</span>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
