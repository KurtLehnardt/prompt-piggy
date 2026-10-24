'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * The shared pig's current level, name, and rule version, from the snapshot
 * or the latest server response (docs/ARCHITECTURE.md sections 9.1 and 9.3).
 * When the level changes, it announces the change in a live region.
 */
export type LevelBannerProps = {
  level: number
  name: string
  /** The level's active rule version; null while unknown. */
  ruleVersion: number | null
  className?: string
}

function announcementFor(from: number, to: number, name: string): string {
  return to > from ? `Level up! The pig is now level ${to}: ${name}.` : `New round: the pig is back to level ${to}: ${name}.`
}

export function LevelBanner({ level, name, ruleVersion, className }: LevelBannerProps) {
  const [seenLevel, setSeenLevel] = useState(level)
  const [announcement, setAnnouncement] = useState<string | null>(null)
  // Derived state: a new level from the server replaces the announcement.
  if (level !== seenLevel) {
    setSeenLevel(level)
    setAnnouncement(announcementFor(seenLevel, level, name))
  }

  return (
    <section
      aria-label="Current pig"
      className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1', className)}
      data-testid="level-banner"
      data-level={level}
    >
      <h1 className="text-2xl font-bold tracking-tight">
        Level {level}: {name}
      </h1>
      {ruleVersion !== null ? (
        <span className="text-sm text-muted-foreground" data-testid="rule-version">
          Rules v{ruleVersion}
        </span>
      ) : null}
      <p aria-live="polite" className="w-full text-sm font-semibold text-emerald-600 dark:text-emerald-400" data-testid="level-announcement">
        {announcement ?? ''}
      </p>
    </section>
  )
}
