'use client'

import { useCallback, useState } from 'react'
import { gameFromRow, type LiveGame } from '@/lib/hooks/live-rows'
import { useRealtime, type RealtimeStatus } from '@/lib/hooks/use-realtime'
import { FALLBACK_SNAPSHOT_INTERVAL_MS, useSnapshot } from '@/lib/hooks/use-snapshot'
import type { LiveSnapshotDTO } from '@/types/api'

/**
 * The treasury and current pig for /live (docs/ARCHITECTURE.md sections 12.2
 * and 12.3). It subscribes to game_state UPDATE and switches to polling the
 * snapshot every 2 seconds when the channel is not SUBSCRIBED within 5
 * seconds or reports CHANNEL_ERROR or TIMED_OUT (`isPolling`). It also polls
 * while it has no data yet, for example when the server could not build the
 * first snapshot.
 */
export type UseTreasuryOptions = {
  initial: LiveGame | null
  enabled?: boolean
  onSnapshot?: (snapshot: LiveSnapshotDTO) => void
}

export type UseTreasuryResult = { game: LiveGame | null; isPolling: boolean; status: RealtimeStatus }

export function useTreasury({ initial, enabled = true, onSnapshot }: UseTreasuryOptions): UseTreasuryResult {
  const [game, setGame] = useState<LiveGame | null>(initial)

  const onRow = useCallback((row: Record<string, unknown>) => {
    const next = gameFromRow(row)
    if (next) setGame(next)
  }, [])
  const realtime = useRealtime({ table: 'game_state', event: 'UPDATE', onRow, enabled })

  const isPolling = enabled && (realtime.needsFallback || game === null)
  const handleSnapshot = useCallback(
    (snapshot: LiveSnapshotDTO) => {
      setGame(snapshot.game)
      onSnapshot?.(snapshot)
    },
    [onSnapshot]
  )
  useSnapshot({ intervalMs: FALLBACK_SNAPSHOT_INTERVAL_MS, enabled: isPolling, onSnapshot: handleSnapshot })

  return { game, isPolling, status: realtime.status }
}
