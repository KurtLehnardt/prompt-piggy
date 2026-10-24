'use client'

import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * A typed postgres_changes subscription (docs/ARCHITECTURE.md sections 5.5,
 * 12.2, and 12.3; threat T15). It copies skylite's use-realtime: the
 * callback lives in a ref, so a new callback never resubscribes, and the
 * channel is removed on unmount. It adds typed rows, one event per hook, and
 * the channel status.
 *
 * Only /live uses it, after its projector cookie verifies, and only for the
 * two published tables. It never uses Presence or Broadcast (R2-S1).
 *
 * `needsFallback` is true when the channel is not SUBSCRIBED within 5
 * seconds, or reports CHANNEL_ERROR, TIMED_OUT, or CLOSED, or when no client
 * can be created; the callers then poll the snapshot. It turns false again
 * when supabase-js rejoins and reports SUBSCRIBED.
 */

/** The only tables in the realtime publication (T15). */
export type LiveTable = 'game_state' | 'live_feed'
export type LiveChangeEvent = 'INSERT' | 'UPDATE'
export type RealtimeStatus = 'connecting' | 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'

export const SUBSCRIBE_DEADLINE_MS = 5_000

const FAILED: ReadonlySet<RealtimeStatus> = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])

/** The part of the browser client this hook calls, so tests can pass a fake. */
export type RealtimeClient = Pick<ReturnType<typeof createClient>, 'channel' | 'removeChannel'>

export type UseRealtimeOptions<Row> = {
  table: LiveTable
  event: LiveChangeEvent
  /** Receives the new row of each change. Rows are untrusted input: validate before use. */
  onRow: (row: Row) => void
  enabled?: boolean
  /** Defaults to the browser client. */
  getClient?: () => RealtimeClient
}

export type UseRealtimeResult = { status: RealtimeStatus; needsFallback: boolean }

function defaultClient(): RealtimeClient {
  return createClient()
}

export function useRealtime<Row extends Record<string, unknown>>({
  table,
  event,
  onRow,
  enabled = true,
  getClient = defaultClient,
}: UseRealtimeOptions<Row>): UseRealtimeResult {
  const onRowRef = useRef(onRow)
  useEffect(() => {
    onRowRef.current = onRow
  }, [onRow])

  const id = useId()
  const [status, setStatus] = useState<RealtimeStatus>('connecting')
  const [stalled, setStalled] = useState(false)

  const client = useMemo<RealtimeClient | null>(() => {
    if (!enabled) return null
    try {
      return getClient()
    } catch {
      return null
    }
  }, [enabled, getClient])

  useEffect(() => {
    if (!client) return
    let subscribed = false
    const deadline = setTimeout(() => {
      if (!subscribed) setStalled(true)
    }, SUBSCRIBE_DEADLINE_MS)

    const channel = client
      .channel(`live:${table}:${event.toLowerCase()}:${id}`)
      .on<Row>('postgres_changes', { event, schema: 'public', table }, (payload: RealtimePostgresChangesPayload<Row>) => {
        const row: unknown = (payload as { new?: unknown } | null)?.new
        if (row !== null && typeof row === 'object') onRowRef.current(row as Row)
      })
      .subscribe((next) => {
        if (next === 'SUBSCRIBED') {
          subscribed = true
          setStalled(false)
        }
        setStatus(next as RealtimeStatus)
      })

    return () => {
      clearTimeout(deadline)
      void client.removeChannel(channel)
    }
  }, [client, table, event, id])

  const needsFallback =
    enabled && (client === null || FAILED.has(status) || (status !== 'SUBSCRIBED' && stalled))
  return { status: client === null && enabled ? 'CHANNEL_ERROR' : status, needsFallback }
}
