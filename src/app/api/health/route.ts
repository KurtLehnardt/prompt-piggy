import { NextResponse } from 'next/server'
import { errorResponse, mapRpcError } from '@/lib/errors'
import { attemptsBlockedByEnv } from '@/lib/ops/kill-switch'
import { createAnonClient } from '@/lib/supabase/anon'
import type { HealthDTO } from '@/types/api'

/**
 * GET /api/health (docs/ARCHITECTURE.md section 7; P2-04). Public and
 * CDN-cached for 5 seconds: `{ ok: true, attemptsEnabled }` from
 * get_public_config() through the cookie-less anon client. attemptsEnabled is
 * also false while PIGGY_KILL_SWITCH (or a server environment that does not
 * parse) refuses every attempt. It ignores the query string, and the proxy
 * matcher skips this path. A database or environment failure answers with
 * the shared error body (503 `unavailable` or 500 `internal`), which is never
 * cached.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { data, error } = await createAnonClient().rpc('get_public_config')
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : null
    const body: HealthDTO = { ok: true, attemptsEnabled: row?.attempts_enabled === true && !attemptsBlockedByEnv() }
    return NextResponse.json(body, { headers: { 'cache-control': 'public, s-maxage=5' } })
  } catch (error) {
    const mapping = mapRpcError(error)
    if (mapping.log) console.error('The health check failed.', mapping.logContext)
    return errorResponse(mapping)
  }
}
