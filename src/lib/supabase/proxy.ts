import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/types/database'
import { missingPublicSupabaseEnv, readPublicSupabaseEnv } from '@/lib/supabase/env'

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
 *
 * The src/proxy.ts matcher already skips the cookie-less routes
 * `/api/live/snapshot`, `/api/health`, `/api/cron/*`, and `/api/smoke`, so the
 * proxy never runs for them. They stay listed here so that they remain public
 * even if the matcher changes.
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

/** Where a signed-out visitor is sent, and where a signed-in visitor to /login is sent by default. */
export const LOGIN_PATH = '/login'
export const HOME_PATH = '/play'

/**
 * The query parameter that carries the page a signed-out visitor asked for, so
 * the login flow can return there (ARCHITECTURE section 7, `/auth/callback?next=`).
 */
export const NEXT_PARAM = 'next'

const MAX_NEXT_LENGTH = 2048

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
 * Returns `candidate` as a same-origin, path-only redirect target, or null.
 *
 * It accepts only a single leading "/" and rejects "//host", "/\host", an
 * encoded slash or backslash right after the leading "/", backslashes,
 * whitespace, and control characters anywhere, so neither a browser nor a later
 * decode can turn it into another origin. It also rejects /login (a signed-in
 * visitor would be sent back to /login forever) and /api paths (a JSON
 * response is never a page to return to). The result is normalized by the URL
 * parser and drops any fragment.
 */
export function safeNextPath(candidate: string | null | undefined): string | null {
  if (!candidate || candidate.length > MAX_NEXT_LENGTH) return null
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null
  if (/[\\\s\u0000-\u001f\u007f]/.test(candidate)) return null
  if (/^\/%(?:2f|5c)/i.test(candidate)) return null

  const base = 'https://next.invalid'
  let parsed: URL
  try {
    parsed = new URL(candidate, base)
  } catch {
    return null
  }
  if (parsed.origin !== base) return null
  if (matchesBoundary(parsed.pathname, LOGIN_PATH) || isApiPath(parsed.pathname)) return null
  return parsed.pathname + parsed.search
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

let reportedMissingEnv = false

/** Logs the missing setting names once per server instance. Never logs a value. */
function reportMissingEnv(): void {
  if (reportedMissingEnv) return
  reportedMissingEnv = true
  console.error(
    `Supabase is not configured: missing ${missingPublicSupabaseEnv().join(' and ')}. ` +
      'Public paths still render; every other page and API route returns 503 until it is set.'
  )
}

/**
 * The fail-closed answer for a protected route when Supabase is not
 * configured. Public paths never get here, so the health page can still report
 * what is missing.
 */
function notConfigured(pathname: string): NextResponse {
  const headers = { 'cache-control': 'no-store' }
  if (isApiPath(pathname)) {
    return NextResponse.json(
      { error: 'The service is not configured yet.', code: 'internal' },
      { status: 503, headers }
    )
  }
  return new NextResponse('Prompt Piggy is not configured yet. The /health page lists what is missing.', {
    status: 503,
    headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
  })
}

/** The part of the Supabase Auth client that confirmUser needs. */
type AuthUserLookup = {
  getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }>
}

/**
 * Asks the Auth server whether the session still exists. Any error, including
 * a network failure, counts as signed out.
 */
async function confirmUser(auth: AuthUserLookup): Promise<boolean> {
  try {
    const { data, error } = await auth.getUser()
    return !error && typeof data.user?.id === 'string'
  } catch {
    return false
  }
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
  const pathname = request.nextUrl.pathname
  const isPublic = isPublicPath(pathname)
  const isApi = isApiPath(pathname)
  const isLogin = pathname === LOGIN_PATH

  const env = readPublicSupabaseEnv()
  if (!env) {
    // A fresh deployment, or one with only some of the Supabase settings. Fail
    // closed: public paths render so /health can report what is missing, and
    // every other route returns 503 instead of passing through as if the
    // visitor had been checked.
    reportMissingEnv()
    if (isPublic) return NextResponse.next({ request })
    return notConfigured(pathname)
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient<Database>(env.url, env.publishableKey, {
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
  // the access token's signature and expiry, so a forged cookie never counts as
  // a user.
  let hasClaims = false
  try {
    const { data } = await supabase.auth.getClaims()
    hasClaims = typeof data?.claims?.sub === 'string'
  } catch {
    // Fail closed: if the session cannot be verified, treat the visitor as
    // signed out. Public paths still work.
    hasClaims = false
  }

  // With asymmetric signing keys, the default for new projects, getClaims()
  // checks the token locally, so it cannot see a session that was revoked by a
  // sign-out on another device or by deleting the user. Pages that require a
  // user check with getUser(), which asks the Auth server. If the proxy trusted
  // the claims alone, such a visitor would loop between a page that sends them
  // to /login and a /login that sends them back. So wherever the proxy acts on
  // "signed in" for a page, it confirms with getUser() first: before letting a
  // visitor onto a protected page, and before sending a visitor away from
  // /login. Public pages and API routes keep the getClaims() fast path: public
  // pages do not depend on the answer, and every API route handler verifies
  // the user with getUser() itself and answers 401 JSON, which cannot loop.
  // When getUser() finds the session gone, it clears the session cookies
  // through setAll, and carrySession() copies that onto the redirect.
  let signedIn = hasClaims
  if (hasClaims && (isLogin || (!isPublic && !isApi))) {
    signedIn = await confirmUser(supabase.auth)
  }

  if (!signedIn && !isPublic) {
    if (isApi) {
      // API callers get a JSON error they can handle, not an HTML login page.
      return carrySession(
        response,
        NextResponse.json({ error: 'Sign in required.', code: 'unauthorized' }, { status: 401 })
      )
    }
    const loginUrl = new URL(LOGIN_PATH, request.nextUrl.origin)
    const next = safeNextPath(pathname + request.nextUrl.search)
    if (next) loginUrl.searchParams.set(NEXT_PARAM, next)
    return carrySession(response, NextResponse.redirect(loginUrl))
  }

  if (signedIn && isLogin) {
    const target = safeNextPath(request.nextUrl.searchParams.get(NEXT_PARAM)) ?? HOME_PATH
    return carrySession(response, NextResponse.redirect(new URL(target, request.nextUrl.origin)))
  }

  return response
}
