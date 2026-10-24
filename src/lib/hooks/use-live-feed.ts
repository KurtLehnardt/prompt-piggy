'use client'

import { useCallback, useState } from 'react'
import { feedItemFromRow, mergeFeed } from '@/lib/hooks/live-rows'
import { useRealtime, type RealtimeStatus } from '@/lib/hooks/use-realtime'
import { FALLBACK_SNAPSHOT_INTERVAL_MS, useSnapshot } from '@/lib/hooks/use-snapshot'
import type { LiveFeedItemDTO, LiveSnapshotDTO } from '@/types/api'

/**
 * The /live attempt and event feed (docs/ARCHITECTURE.md sections 12.2 and
 * 12.3). It subscribes to live_feed INSERT and keeps the newest 20 items; it
 * switches to polling the snapshot every 2 seconds when the channel is not
 * SUBSCRIBED within 5 seconds or reports CHANNEL_ERROR or TIMED_OUT
 * (`isPolling`). Rows carry enums, numbers, and pseudonymous ids only.
 */
export type UseLiveFeedOptions = {
  initial: readonly LiveFeedItemDTO[]
  enabled?: boolean
  onSnapshot?: (snapshot: LiveSnapshotDTO) => void
}

export type UseLiveFeedResult = { feed: LiveFeedItemDTO[]; isPolling: boolean; status: RealtimeStatus }

export function useLiveFeed({ initial, enabled = true, onSnapshot }: UseLiveFeedOptions): UseLiveFeedResult {
  const [feed, setFeed] = useState<LiveFeedItemDTO[]>(() => mergeFeed(initial, []))

  const onRow = useCallback((row: Record<string, unknown>) => {
    const item = feedItemFromRow(row)
    if (item) setFeed((current) => mergeFeed([item], current))
  }, [])
  const realtime = useRealtime({ table: 'live_feed', event: 'INSERT', onRow, enabled })

  const isPolling = enabled && realtime.needsFallback
  const handleSnapshot = useCallback(
    (snapshot: LiveSnapshotDTO) => {
      setFeed((current) => mergeFeed(snapshot.feed, current))
      onSnapshot?.(snapshot)
    },
    [onSnapshot]
  )
  useSnapshot({ intervalMs: FALLBACK_SNAPSHOT_INTERVAL_MS, enabled: isPolling, onSnapshot: handleSnapshot })

  return { feed, isPolling, status: realtime.status }
}
