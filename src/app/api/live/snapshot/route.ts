import { NextResponse } from 'next/server'
import { errorResponse, mapRpcError } from '@/lib/errors'
import { buildLiveSnapshot } from '@/lib/live/snapshot'

/**
 * GET /api/live/snapshot (docs/ARCHITECTURE.md sections 7 and 12.3; R1-24a,
 * R2-07, P2-04). Public and CDN-cached for 2 seconds: the game, the level
 * versions, the newest 20 feed rows, and the public config, with no player
 * list. It reads through the cookie-less anon client, takes no argument, and
 * ignores the query string, so every caller gets the same bytes. The proxy
 * matcher skips this path.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SNAPSHOT_CACHE_CONTROL = 'public, s-maxage=2, stale-while-revalidate=5'

export async function GET() {
  try {
    const snapshot = await buildLiveSnapshot()
    return NextResponse.json(snapshot, { headers: { 'cache-control': SNAPSHOT_CACHE_CONTROL } })
  } catch (error) {
    const mapping = mapRpcError(error)
    if (mapping.log) console.error('The live snapshot failed.', mapping.logContext)
    return errorResponse(mapping)
  }
}
