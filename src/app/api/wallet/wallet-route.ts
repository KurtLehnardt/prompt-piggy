import 'server-only'
import type { User } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import type { z } from 'zod'
import { requireUserApi } from '@/lib/auth/require-user'
import { errorResponse, jsonError, mapRpcError, type FundsAction } from '@/lib/errors'
import { assertSameOrigin } from '@/lib/http/origin'
import { getLimits } from '@/lib/ops/limits'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ApiError } from '@/types/api'

/**
 * The shared steps of the two wallet routes (docs/ARCHITECTURE.md section 7;
 * CH-1, CH-2; R2-16; PR #6 review, M5):
 *
 * 1. The Origin must be the app origin, or the answer is 403 `forbidden`.
 * 2. The caller must be a signed-in, non-anonymous user (requireUserApi()).
 * 3. The body must match the route's zod strictObject, so an unknown key, such
 *    as a price, is a 400.
 * 4. The RPC runs through the secret-key client, because repair_glass and
 *    donate are executable by service_role only. The user id comes from the
 *    verified session, never from the body.
 *
 * Database errors go through mapRpcError(), which never echoes SQL text; only
 * the SQLSTATE and the recognized token are logged.
 */

/** The wallet token bucket's capacity (section 12.1: burst 5, refill RATE_LIMIT_WALLET_PER_MIN). */
export const WALLET_RATE_BURST = 5

export type AdminClient = ReturnType<typeof createAdminClient>

export type WalletRouteContext<Body> = {
  user: User
  body: Body
  admin: AdminClient
  rate: { capacity: number; refillPerMin: number }
}

const NO_STORE = { 'cache-control': 'no-store' }

export function jsonOk<T>(body: T): NextResponse<T> {
  return NextResponse.json(body, { status: 200, headers: NO_STORE })
}

/** Maps and, for server bugs only, logs a database error. */
export function rpcFailure(route: string, error: unknown, action: FundsAction): NextResponse<ApiError> {
  const mapping = mapRpcError(error, { action })
  if (mapping.log) console.error(`${route}: RPC failed`, mapping.logContext)
  return errorResponse(mapping)
}

export async function runWalletRoute<Schema extends z.ZodType>(
  request: NextRequest,
  schema: Schema,
  handler: (context: WalletRouteContext<z.output<Schema>>) => Promise<NextResponse>
): Promise<NextResponse> {
  if (!assertSameOrigin(request)) return jsonError('forbidden', 403)

  const auth = await requireUserApi()
  if (!auth.ok) return auth.response

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return jsonError('invalid_request', 400)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return jsonError('invalid_request', 400)

  let admin: AdminClient
  let rate: WalletRouteContext<unknown>['rate']
  try {
    rate = { capacity: WALLET_RATE_BURST, refillPerMin: getLimits().walletPerMin }
    admin = createAdminClient()
  } catch (error) {
    return errorResponse(mapRpcError(error))
  }

  return handler({ user: auth.user, body: parsed.data, admin, rate })
}
