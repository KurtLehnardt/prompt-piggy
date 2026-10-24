'use client'

import { useWallList, type WallListResult } from '@/lib/presence/use-wall-list'

/**
 * The /live presence wall (docs/ARCHITECTURE.md sections 9.7 and 12.2). It
 * polls GET /live/players every 3 seconds while the tab is visible; the
 * route answers only to a valid projector cookie, which the browser sends
 * because the cookie's path is /live.
 */
export const LIVE_PLAYERS_URL = '/live/players'
export const LIVE_PLAYERS_INTERVAL_MS = 3_000

export function useLivePlayers({ enabled = true }: { enabled?: boolean } = {}): WallListResult {
  return useWallList({ url: LIVE_PLAYERS_URL, method: 'GET', intervalMs: LIVE_PLAYERS_INTERVAL_MS, enabled })
}
