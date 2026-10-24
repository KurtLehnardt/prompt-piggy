import { levelName, levelTitle, timeAgo } from '@/components/live/labels'
import { cn } from '@/lib/utils'
import type { LiveFeedItemDTO } from '@/types/api'

/**
 * The current pig and each level's rule version and last hardening (docs/
 * ARCHITECTURE.md section 12.2). Props are numbers only; level names come
 * from the public config through labels.ts.
 */
export type LevelVersion = { id: number; ruleVersion: number; lastHardenedAtMs: number | null }

export type LevelStatusProps = {
  currentLevel: number | null
  levels: readonly LevelVersion[]
  nowMs: number
  className?: string
}

/**
 * Applies hardened and rules_reset feed events newer than `sinceFeedId` to a
 * level list, oldest first, so /live shows a new version before the next
 * snapshot arrives.
 */
export function applyFeedToLevels(
  levels: readonly LevelVersion[],
  feed: readonly LiveFeedItemDTO[],
  sinceFeedId: number
): LevelVersion[] {
  const next = levels.map((level) => ({ ...level }))
  const events = feed
    .filter((item) => item.id > sinceFeedId && (item.type === 'hardened' || item.type === 'rules_reset'))
    .sort((a, b) => a.id - b.id)
  for (const event of events) {
    const level = next.find((candidate) => candidate.id === event.level)
    if (!level) continue
    if (event.ruleVersion !== null) level.ruleVersion = event.ruleVersion
    if (event.type === 'hardened') {
      const at = Date.parse(event.at)
      if (!Number.isNaN(at)) level.lastHardenedAtMs = at
    }
  }
  return next
}

export function LevelStatus({ currentLevel, levels, nowMs, className }: LevelStatusProps) {
  const current = levels.find((level) => level.id === currentLevel)
  return (
    <section aria-label="The pig" className={cn('flex flex-col gap-4', className)} data-testid="level-status">
      <div>
        <p className="text-[28px] uppercase tracking-wide opacity-70">Current pig</p>
        <p className="text-[48px] font-bold leading-tight">{currentLevel === null ? 'Loading...' : levelTitle(currentLevel)}</p>
        {current ? <p className="text-[28px] opacity-80">Rules v{current.ruleVersion}</p> : null}
      </div>
      <ul className="flex flex-col gap-1">
        {levels.map((level) => (
          <li
            key={level.id}
            className={cn('flex items-baseline justify-between gap-4 text-[28px]', level.id === currentLevel ? 'font-semibold' : 'opacity-75')}
          >
            <span>
              L{level.id} {levelName(level.id)}
            </span>
            <span className="tabular-nums">
              v{level.ruleVersion} · {level.lastHardenedAtMs === null ? 'never hardened' : `hardened ${timeAgo(level.lastHardenedAtMs, nowMs)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
