import { NextResponse, type NextRequest } from 'next/server'
import { errorResponse, jsonError, mapRpcError } from '@/lib/errors'
import { hasProjectorAccess, PROJECTOR_COOKIE } from '@/lib/live/projector-cookie'
import { knownHashOf, parseWallRow, wallResponseBody, WALL_SQL_LIMIT, WALL_WINDOW_SECONDS } from '@/lib/live/wall-list'
import { createAdminClient } from '@/lib/supabase/admin'
import type { LivePlayersDTO } from '@/types/api'

/**
 * GET /live/players (docs/ARCHITECTURE.md sections 7, 9.7, and 12.2; threat
 * T32; REVIEW-2 R2-07; REVIEW-3 R3-02).
 *
 * The projector wall list. It answers 401 unless the `pp_live` cookie
 * verifies against LIVE_VIEW_TOKEN, and only then calls get_live_players
 * through the service role (the function is service_role only). /live polls
 * it every 3 seconds with the last hash in `?h=`; a matching hash answers
 * `{ unchanged: true, listHash }` with no list. Read-only, so there is no
 * Origin check; the cookie is SameSite=Strict and Path=/live. Never cached.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!hasProjectorAccess(request.cookies.get(PROJECTOR_COOKIE)?.value)) {
    return jsonError('unauthorized', 401, 'This screen needs the projector link.')
  }

  const knownHash = knownHashOf(request.nextUrl)
  try {
    const { data, error } = await createAdminClient().rpc('get_live_players', {
      p_window_seconds: WALL_WINDOW_SECONDS,
      p_limit: WALL_SQL_LIMIT,
      ...(knownHash ? { p_known_hash: knownHash } : {}),
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : undefined

    let body: LivePlayersDTO
    if (row) body = wallResponseBody(parseWallRow(row), knownHash)
    else if (knownHash) body = { unchanged: true, listHash: knownHash }
    else throw new Error('get_live_players returned no row without a known hash.')

    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    const mapping = mapRpcError(error)
    if (mapping.log) console.error('The projector wall list failed.', mapping.logContext)
    return errorResponse(mapping)
  }
}
