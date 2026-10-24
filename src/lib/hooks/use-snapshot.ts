'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useVisibleInterval } from '@/lib/hooks/use-visible-interval'
import { LiveSnapshotSchema, type LiveSnapshotDTO } from '@/types/api'

/**
 * Polls the public, CDN-cached snapshot (docs/ARCHITECTURE.md sections 12.3
 * and 12.4; CH-5).
 *
 * Player pages use this, every 5 seconds while the tab is visible, and never
 * open a Supabase Realtime channel: this hook creates no Supabase client at
 * all. /live's realtime hooks reuse it at 2 seconds as their fallback.
 *
 * A failed or malformed response is ignored and the last good snapshot stays
 * on screen. `onSnapshot` runs for each good response.
 */
export const SNAPSHOT_URL = '/api/live/snapshot'
export const PLAYER_SNAPSHOT_INTERVAL_MS = 5_000
export const FALLBACK_SNAPSHOT_INTERVAL_MS = 2_000

export type UseSnapshotOptions = {
  intervalMs?: number
  enabled?: boolean
  initial?: LiveSnapshotDTO | null
  onSnapshot?: (snapshot: LiveSnapshotDTO) => void
}

export type UseSnapshotResult = { snapshot: LiveSnapshotDTO | null }

export function useSnapshot({
  intervalMs = PLAYER_SNAPSHOT_INTERVAL_MS,
  enabled = true,
  initial = null,
  onSnapshot,
}: UseSnapshotOptions = {}): UseSnapshotResult {
  const [snapshot, setSnapshot] = useState<LiveSnapshotDTO | null>(initial)
  const inFlight = useRef(false)
  const onSnapshotRef = useRef(onSnapshot)
  useEffect(() => {
    onSnapshotRef.current = onSnapshot
  }, [onSnapshot])

  const tick = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const response = await fetch(SNAPSHOT_URL)
      if (!response.ok) return
      const parsed = LiveSnapshotSchema.safeParse(await response.json())
      if (!parsed.success) return
      setSnapshot(parsed.data)
      onSnapshotRef.current?.(parsed.data)
    } catch {
      // Offline or a bad response: keep the last good snapshot.
    } finally {
      inFlight.current = false
    }
  }, [])

  useVisibleInterval(tick, intervalMs, enabled)
  return { snapshot }
}
