import 'server-only'
import type { NextResponse } from 'next/server'
import { jsonError } from '@/lib/errors'
import { requireEnv } from '@/lib/env'
import { safeEqual } from '@/lib/auth/secret-compare'
import type { ApiError } from '@/types/api'

/**
 * Bearer-token check for the cron, hardening-kick, and smoke routes
 * (docs/ARCHITECTURE.md section 1.2 row 14, section 7, and section 11 T22),
 * copied from skylite's calendar-sync route.
 *
 * Returns null when the request carries `Authorization: Bearer <CRON_SECRET>`,
 * and otherwise the response the route must return at once:
 *
 * - 500 `internal` when CRON_SECRET is unset, empty, or invalid. The route is
 *   then closed to everyone; it never falls back to an empty secret.
 * - 401 `unauthorized` for a missing, wrong, or multibyte header.
 *
 * The secret is read through requireEnv() at the point of use and is never
 * logged or echoed (PR #6 review, M1).
 */
export function verifyCronRequest(request: Request): NextResponse<ApiError> | null {
  let secret: string
  try {
    secret = requireEnv('CRON_SECRET').CRON_SECRET
  } catch (error) {
    // ServerEnvError messages list variable names only, never values.
    console.error(
      'Cron authentication is closed:',
      error instanceof Error && error.name === 'ServerEnvError' ? error.message : 'the server environment could not be read.'
    )
    return jsonError('internal', 500, 'The cron secret is not configured.')
  }
  if (secret === '') return jsonError('internal', 500, 'The cron secret is not configured.')

  const presented = request.headers.get('authorization')
  if (!safeEqual(presented, `Bearer ${secret}`)) {
    return jsonError('unauthorized', 401, 'Unauthorized.')
  }
  return null
}
