'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { applyFeedToLevels, LevelStatus, type LevelVersion } from '@/components/live/level-status'
import { LiveFeed } from '@/components/live/live-feed'
import { PresenceWall } from '@/components/presence/presence-wall'
import { TreasuryCounter } from '@/components/treasury/treasury-counter'
import { useLiveFeed } from '@/lib/hooks/use-live-feed'
import { useTreasury } from '@/lib/hooks/use-treasury'
import { useLivePlayers } from '@/lib/presence/use-live-players'
import type { LiveSnapshotDTO } from '@/types/api'

/**
 * The /live projector view (docs/ARCHITECTURE.md section 12.2; CH-6). It is
 * rendered only after the server verified the projector cookie.
 *
 * - Treasury and feed: postgres_changes on game_state and live_feed, with
 *   the snapshot as a 2-second polling fallback and a "Polling" indicator.
 * - Wall: GET /live/players every 3 seconds (no Realtime, R2-S1).
 * - Labels only: enums, numbers, and the players list; never a prompt,
 *   reply, or email.
 *
 * Laid out for 1920x1080 with text of at least 28 px.
 */
export type LiveProjectorProps = { initial: LiveSnapshotDTO | null }

type LevelBase = { levels: LevelVersion[]; sinceFeedId: number }

function baseOf(snapshot: LiveSnapshotDTO | null): LevelBase {
  if (!snapshot) return { levels: [], sinceFeedId: 0 }
  return {
    levels: snapshot.levels.map((level) => {
      const at = level.lastHardenedAt === null ? Number.NaN : Date.parse(level.lastHardenedAt)
      return { id: level.id, ruleVersion: level.ruleVersion, lastHardenedAtMs: Number.isNaN(at) ? null : at }
    }),
    sinceFeedId: snapshot.feed.reduce((max, item) => Math.max(max, item.id), 0),
  }
}

const CLOCK_TICK_MS = 15_000

export function LiveProjector({ initial }: LiveProjectorProps) {
  const [base, setBase] = useState<LevelBase>(() => baseOf(initial))
  const onSnapshot = useCallback((snapshot: LiveSnapshotDTO) => setBase(baseOf(snapshot)), [])

  const treasury = useTreasury({ initial: initial?.game ?? null, onSnapshot })
  const live = useLiveFeed({ initial: initial?.feed ?? [], onSnapshot })
  const wall = useLivePlayers()

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const levels = useMemo(() => applyFeedToLevels(base.levels, live.feed, base.sinceFeedId), [base, live.feed])
  const isPolling = treasury.isPolling || live.isPolling

  return (
    <main className="grid h-screen grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-10 overflow-hidden p-10" data-testid="live-projector">
      <div className="flex min-h-0 flex-col gap-10">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-[40px] font-bold">Prompt Piggy</h1>
          <span
            className={
              isPolling
                ? 'rounded-full bg-amber-500/30 px-4 py-1 text-[28px] text-amber-200'
                : 'rounded-full bg-emerald-500/25 px-4 py-1 text-[28px] text-emerald-200'
            }
            data-testid="polling-indicator"
            data-polling={isPolling ? 'true' : 'false'}
          >
            {isPolling ? 'Polling' : 'Live'}
          </span>
        </header>
        <TreasuryCounter
          cents={treasury.game?.treasuryCents ?? 0}
          label="Vault treasury"
          className="text-[48px]"
          amountClassName="text-[128px] leading-none text-amber-300"
        />
        {treasury.game ? (
          <p className="text-[28px] opacity-80">
            {treasury.game.totals.attempts} attacks · {treasury.game.totals.wins} wins
          </p>
        ) : null}
        <LevelStatus currentLevel={treasury.game?.level ?? null} levels={levels} nowMs={nowMs} />
        <p className="mt-auto text-[28px] opacity-70">All money is mocked. No real payments.</p>
      </div>
      <div className="flex min-h-0 flex-col gap-10">
        {wall.unauthorized ? (
          <p className="text-[28px] text-amber-200">The projector link expired. Open it again to show players.</p>
        ) : null}
        <PresenceWall players={wall.players ?? []} className="max-h-[45%]" />
        <LiveFeed feed={live.feed} players={wall.players} className="flex-1" />
      </div>
    </main>
  )
}
