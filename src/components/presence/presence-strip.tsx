import { AvatarGlow } from '@/components/player/avatar-glow'
import { cn } from '@/lib/utils'
import type { LivePlayerDTO } from '@/types/api'

/**
 * The game-page presence strip (docs/ARCHITECTURE.md section 9.7; CH-2,
 * CH-3; R3-02). It renders the list from usePresencePing(), at most about 30
 * avatars, each with its server-computed aura glow. Names are text only.
 */
export const STRIP_MAX_AVATARS = 30

export type PresenceStripProps = {
  players: readonly LivePlayerDTO[] | null
  max?: number
  className?: string
}

export function PresenceStrip({ players, max = STRIP_MAX_AVATARS, className }: PresenceStripProps) {
  const shown = (players ?? []).slice(0, Math.max(0, max))
  return (
    <section aria-label="Players online" className={cn('flex items-center gap-3', className)} data-testid="presence-strip">
      <span className="shrink-0 text-sm font-medium text-muted-foreground">Playing now</span>
      {shown.length === 0 ? (
        <span className="text-sm text-muted-foreground">{players === null ? 'Loading players...' : 'Just you so far'}</span>
      ) : (
        <ul className="flex flex-wrap items-center gap-2">
          {shown.map((player) => (
            <li key={player.id} title={player.name} data-player-id={player.id}>
              <AvatarGlow name={player.name} avatarUrl={player.avatarUrl} auraBps={player.auraBps} sizePx={32} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
