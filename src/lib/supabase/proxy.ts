import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/types/database'
import { readPublicSupabaseEnv } from '@/lib/supabase/env'

/**
 * Paths that render or respond without a signed-in user.
 *
 * Every entry is matched on a path boundary: the exact path, or the path
 * followed by "/". A bare prefix match would also make a future `/api/cronjobs`,
 * `/healthz`, or `/livestream` public by accident (the skylite `/api/cron`
 * lesson). `/` is matched exactly, because its boundary match is every path.
 *
 * `/api/cron/*` and `/api/smoke` are cookie-less by nature: callers send only
 * an `Authorization: Bearer $CRON_SECRET` header, and each route enforces that
 * secret itself. `/api/test/login` returns 404 unless E2E test mode is on.
 */
export const PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/auth/error',
  '/live',
  '/health',
  '/api/live/snapshot',
  '/api/health',
  '/api/cron',
  '/api/smoke',
  '/api/test/login',
] as const

/** Where a signed-out visitor is sent, and where a signed-in visitor to /login is sent. */
export const LOGIN_PATH = '/login'
export const HOME_PATH = '/play'

/** Headers that stop a CDN from caching a response that carries session cookies. */
const NO_STORE_HEADERS = {
  'cache-control': 'private, no-cache, no-store, must-revalidate, max-age=0',
  expires: '0',
  pragma: 'no-cache',
} as const

function matchesBoundary(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true
  return PUBLIC_PATHS.some((path) => matchesBoundary(pathname, path))
}

function isApiPath(pathname: string): boolean {
  return matchesBoundary(pathname, '/api')
}

/**
 * Copies the refreshed session cookies and the no-store headers from the
 * response that `setAll` built onto a different response (a redirect or an
 * error). Without this the browser keeps a stale token and the user is signed
 * out on the next request.
 */
function carrySession(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
  for (const header of Object.keys(NO_STORE_HEADERS)) {
    const value = from.headers.get(header)
    if (value) to.headers.set(header, value)
  }
  return to
}

/**
 * Refreshes the Supabase session cookie on every matched request and gates
 * pages that need a user. It is called only from src/proxy.ts.
 *
 * This is a convenience gate for navigation, not the authorization boundary:
 * every route handler and server function still verifies the user itself.
 * The Dynamic Validator never runs here (HC-A4).
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const env = readPublicSupabaseEnv()
  if (!env) {
    // A fresh deployment has no Supabase settings yet. Let every request
    // through so the health page can report what is missing, instead of
    // failing every request with an exception.
    return NextResponse.next({ request })
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        )
        for (const [header, value] of Object.entries(NO_STORE_HEADERS)) {
          response.headers.set(header, value)
        }
      },
    },
  })

  // Nothing may run between creating the client and this call. getClaims()
  // refreshes an expiring session, which triggers setAll above, and verifies
  // the access token's signature, so a forged cookie never counts as a user.
  let signedIn = false
  try {
    const { data } = await supabase.auth.getClaims()
    signedIn = typeof data?.claims?.sub === 'string'
  } catch {
    // Fail closed: if the session cannot be verified, treat the visitor as
    // signed out. Public paths still work.
    signedIn = false
  }

  const pathname = request.nextUrl.pathname

  if (!signedIn && !isPublicPath(pathname)) {
    if (isApiPath(pathname)) {
      // API callers get a JSON error they can handle, not an HTML login page.
      return carrySession(
        response,
        NextResponse.json({ error: 'Sign in required.', code: 'unauthorized' }, { status: 401 })
      )
    }
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = LOGIN_PATH
    loginUrl.search = ''
    return carrySession(response, NextResponse.redirect(loginUrl))
  }

  if (signedIn && pathname === LOGIN_PATH) {
    const homeUrl = request.nextUrl.clone()
    homeUrl.pathname = HOME_PATH
    homeUrl.search = ''
    return carrySession(response, NextResponse.redirect(homeUrl))
  }

  return response
}
