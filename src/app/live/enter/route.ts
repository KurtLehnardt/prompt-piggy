import { NextResponse, type NextRequest } from 'next/server'
import { safeEqual } from '@/lib/auth/secret-compare'
import { jsonError } from '@/lib/errors'
import {
  PROJECTOR_COOKIE,
  PROJECTOR_COOKIE_OPTIONS,
  readProjectorToken,
  signProjectorCookie,
} from '@/lib/live/projector-cookie'

/**
 * GET /live/enter?k=<LIVE_VIEW_TOKEN> (docs/ARCHITECTURE.md sections 7 and
 * 12.2; threat T32; REVIEW-2 R2-07; REVIEW-3 R3-10).
 *
 * - The token is read through requireEnv() at the point of use and compared
 *   with `k` by safeEqual(), which is timing-safe and fails closed: an
 *   unset or empty LIVE_VIEW_TOKEN matches nothing (PR #6 review, M1).
 * - A match sets the `pp_live` cookie, an expiring HMAC keyed by the token
 *   (never the token itself), and answers 303 to /live at once, so `?k=`
 *   leaves the address bar.
 * - A wrong, missing, or unconfigured token gets 404 and no cookie.
 * - Every answer carries `Cache-Control: no-store` and
 *   `Referrer-Policy: no-referrer`.
 *
 * Nothing here logs the token, the `k` parameter, the URL, or the cookie.
 *
 * This is a GET link the operator opens once on the projector machine, so it
 * has no Origin check: a top-level navigation carries no Origin header. A
 * cross-site page that guesses the token gains nothing it did not already
 * have.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const

export async function GET(request: NextRequest) {
  const token = readProjectorToken()
  const presented = request.nextUrl.searchParams.get('k')

  if (token === null || !safeEqual(presented, token)) {
    const response = jsonError('not_found', 404)
    for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value)
    return response
  }

  const target = request.nextUrl.clone()
  target.pathname = '/live'
  target.search = ''
  target.hash = ''

  const response = NextResponse.redirect(target, { status: 303, headers: HEADERS })
  response.cookies.set(PROJECTOR_COOKIE, signProjectorCookie(token), PROJECTOR_COOKIE_OPTIONS)
  return response
}
