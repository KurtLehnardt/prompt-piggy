import { NextResponse, type NextRequest } from 'next/server'
import { requireUserApi } from '@/lib/auth/require-user'
import { errorResponse, jsonError, mapRpcError } from '@/lib/errors'
import { assertSameOrigin } from '@/lib/http/origin'
import {
  createWallMemo,
  knownHashOf,
  parseWallRow,
  STRIP_MAX_PLAYERS,
  wallResponseBody,
  WALL_SQL_LIMIT,
  WALL_WINDOW_SECONDS,
  type WallList,
} from '@/lib/live/wall-list'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * POST /api/presence/ping (docs/ARCHITECTURE.md sections 7 and 9.7; threat
 * T27; REVIEW-2 R2-S1; REVIEW-3 R3-02; PR #6 review, M5).
 *
 * The signed-in heartbeat. No Realtime Presence: the wall is the server's
 * list of users who sent this request.
 *
 * 1. A foreign or missing Origin gets 403 `forbidden`.
 * 2. requireUserApi() asks the Auth server; a signed-out or anonymous user
 *    gets 401.
 * 3. The request body is never read, so a body naming another user changes
 *    nothing: presence_ping is called with the id from getUser() only,
 *    through the service role (the function is service_role only). It writes
 *    last_seen_at at most once a minute.
 * 4. The answer is LivePlayersDTO for the game-page strip: at most 30
 *    players, or `{ unchanged: true }` when `?h=` matches. Never cached.
 *
 * The hash covers the full list (up to 150 players), and the strip shows a
 * stable subset of it (highest aura first), so the subset does not rotate as
 * players' last-seen times move and "unchanged" keeps firing (R3-02).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const memo = createWallMemo()

export async function POST(request: NextRequest) {
  if (!assertSameOrigin(request)) return jsonError('forbidden', 403)

  const auth = await requireUserApi()
  if (!auth.ok) return auth.response

  const clientHash = knownHashOf(request.nextUrl)
  const cached = memo.get()
  try {
    const { data, error } = await createAdminClient().rpc('presence_ping', {
      p_user_id: auth.user.id,
      p_window_seconds: WALL_WINDOW_SECONDS,
      p_limit: WALL_SQL_LIMIT,
      ...(cached ? { p_known_hash: cached.listHash } : {}),
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : undefined

    let list: WallList
    if (row) {
      list = parseWallRow(row)
      memo.set(list)
    } else if (cached) {
      list = cached
    } else {
      throw new Error('presence_ping returned no row without a known hash.')
    }

    return NextResponse.json(wallResponseBody(list, clientHash, STRIP_MAX_PLAYERS), {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    const mapping = mapRpcError(error)
    if (mapping.log) console.error('The presence heartbeat failed.', mapping.logContext)
    return errorResponse(mapping)
  }
}
