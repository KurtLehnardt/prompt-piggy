'use client'

import { useWallList, type WallListResult } from '@/lib/presence/use-wall-list'

/**
 * The signed-in heartbeat for the game page (docs/ARCHITECTURE.md section
 * 9.7; R2-S1; threat T27). It POSTs /api/presence/ping on mount and every 10
 * seconds while the tab is visible, stops while it is hidden, and swallows
 * errors. The request has no body: the server takes the user from the
 * session. It exposes the latest strip list (at most about 30 players).
 */
export const PRESENCE_PING_URL = '/api/presence/ping'
export const PRESENCE_PING_INTERVAL_MS = 10_000

export function usePresencePing({ enabled = true }: { enabled?: boolean } = {}): WallListResult {
  return useWallList({ url: PRESENCE_PING_URL, method: 'POST', intervalMs: PRESENCE_PING_INTERVAL_MS, enabled })
}
