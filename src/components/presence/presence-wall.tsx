import { AvatarGlow } from '@/components/player/avatar-glow'
import { cn } from '@/lib/utils'
import type { LivePlayerDTO } from '@/types/api'

/**
 * The /live presence wall (docs/ARCHITECTURE.md sections 9.7 and 12.2;
 * CH-2, CH-3). Every signed-in player on the latest list, each with the
 * server's aura glow, laid out for a 1920x1080 projector: large avatars and
 * 28 px names for a small room, smaller avatars without names once the room
 * fills up. Names are rendered as text only.
 */
export type PresenceWallProps = {
  players: readonly LivePlayerDTO[]
  className?: string
}

/** Avatar size and whether names fit, by head count. */
export function wallLayout(count: number): { sizePx: number; showNames: boolean } {
  if (count <= 18) return { sizePx: 112, showNames: true }
  if (count <= 40) return { sizePx: 88, showNames: true }
  if (count <= 80) return { sizePx: 72, showNames: false }
  return { sizePx: 56, showNames: false }
}

export function PresenceWall({ players, className }: PresenceWallProps) {
  const { sizePx, showNames } = wallLayout(players.length)
  return (
    <section aria-label="Players in the room" className={cn('flex min-h-0 flex-col gap-4', className)} data-testid="presence-wall">
      <h2 className="text-[32px] font-semibold">
        {players.length === 1 ? '1 player online' : `${players.length} players online`}
      </h2>
      {players.length === 0 ? (
        <p className="text-[28px] opacity-80">Sign in on your phone to join the wall.</p>
      ) : (
        <ul className="flex flex-wrap content-start gap-5 overflow-hidden">
          {players.map((player) => (
            <li
              key={player.id}
              className="flex flex-col items-center gap-2"
              style={{ width: showNames ? sizePx + 64 : sizePx }}
              data-player-id={player.id}
              aria-label={player.name}
            >
              <AvatarGlow name={player.name} avatarUrl={player.avatarUrl} auraBps={player.auraBps} sizePx={sizePx} />
              {showNames ? <span className="w-full truncate text-center text-[28px] leading-tight">{player.name}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
