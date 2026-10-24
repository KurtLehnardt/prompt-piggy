'use client'

import { useCallback, useRef, useState } from 'react'
import { useVisibleInterval } from '@/lib/hooks/use-visible-interval'
import { LIST_HASH_PARAM, LivePlayersSchema, type LivePlayerDTO } from '@/types/api'

/**
 * Polls one of the two wall-list routes (docs/ARCHITECTURE.md section 9.7;
 * R2-S1, R3-02). There is no Supabase client here and no Realtime channel:
 * the wall is plain HTTP polling.
 *
 * Each request sends the last list hash in `?h=`; an `unchanged` answer
 * keeps the current list, so an idle wall costs a few bytes per poll. Errors
 * are swallowed as skylite's device heartbeat does, and the last list stays
 * on screen. A 401 sets `unauthorized`, so /live can say its link expired.
 */
export type WallListOptions = {
  url: string
  method: 'GET' | 'POST'
  intervalMs: number
  enabled?: boolean
}

export type WallListResult = { players: LivePlayerDTO[] | null; unauthorized: boolean }

export function useWallList({ url, method, intervalMs, enabled = true }: WallListOptions): WallListResult {
  const [players, setPlayers] = useState<LivePlayerDTO[] | null>(null)
  const [unauthorized, setUnauthorized] = useState(false)
  const hashRef = useRef<string | null>(null)
  const inFlight = useRef(false)

  const tick = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const hash = hashRef.current
      const target = hash ? `${url}?${LIST_HASH_PARAM}=${encodeURIComponent(hash)}` : url
      const response = await fetch(target, { method, cache: 'no-store' })
      setUnauthorized(response.status === 401)
      if (!response.ok) return
      const parsed = LivePlayersSchema.safeParse(await response.json())
      if (!parsed.success) return
      if (!parsed.data.unchanged) {
        hashRef.current = parsed.data.listHash
        setPlayers(parsed.data.players)
      }
    } catch {
      // Offline or a bad response: keep the last list.
    } finally {
      inFlight.current = false
    }
  }, [url, method])

  useVisibleInterval(tick, intervalMs, enabled)
  return { players, unauthorized }
}
