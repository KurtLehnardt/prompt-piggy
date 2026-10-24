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
 * Backslashes, whitespace (including Unicode spaces), and C0 and C1 control
 * characters. The URL parser silently drops tab, CR, and LF and reads "\" as
 * "/", so "/\t/evil.example" and "/\evil.example" would parse as "//evil.example".
 */
const UNSAFE_CHARACTER = /[\\\s\u0000-\u001f\u007f-\u009f]/

/** A percent-encoded slash, backslash, or control character inside a path. */
const UNSAFE_ENCODED_IN_PATH = /%(?:2f|5c|[01][0-9a-f]|7f)/i

function parseUrl(input: string, base?: string): URL | null {
  try {
    return new URL(input, base)
  } catch {
    return null
  }
}

/** Starts with exactly one "/", which a browser cannot read as "//host" or "/\host". */
function hasSingleLeadingSlash(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
}

/**
 * Returns `candidate` as a path on `requestOrigin` that is safe to redirect
 * to, or null.
 *
 * The URL parser normalizes the path: it removes dot segments, so
 * "/.//evil.example", "/%2e//evil.example", and "/a/..//evil.example" all come
 * out as "//evil.example", which a browser reads as another host. So the
 * checks run twice: on the raw candidate, before the parser can drop or
 * rewrite characters, and again on the normalized pathname and search that are
 * actually returned. The result is accepted only when it starts with a single
 * "/", contains no backslash, whitespace, control character, or encoded slash,
 * backslash, or control character in its path, and parses back to itself on
 * `requestOrigin`.
 *
 * It also rejects /login (a signed-in visitor would be sent back to /login
 * forever) and /api paths (a JSON response is never a page to return to). Any
 * fragment is dropped.
 */
export function safeNextPath(
  candidate: string | null | undefined,
  requestOrigin: string
): string | null {
  if (!candidate || candidate.length > MAX_NEXT_LENGTH) return null
  if (UNSAFE_CHARACTER.test(candidate) || !hasSingleLeadingSlash(candidate)) return null

  const origin = parseUrl(requestOrigin)?.origin
  if (!origin || origin === 'null') return null

  const parsed = parseUrl(candidate, origin)
  if (!parsed || parsed.origin !== origin) return null

  // Check the output, not only the input.
  const target = parsed.pathname + parsed.search
  if (
    target.length > MAX_NEXT_LENGTH ||
    !hasSingleLeadingSlash(target) ||
    UNSAFE_CHARACTER.test(target) ||
    UNSAFE_ENCODED_IN_PATH.test(parsed.pathname)
  ) {
    return null
  }
  const reparsed = parseUrl(target, origin)
  if (!reparsed || reparsed.origin !== origin || reparsed.pathname + reparsed.search !== target) {
    return null
  }

  if (matchesBoundary(parsed.pathname, LOGIN_PATH) || isApiPath(parsed.pathname)) return null
  return target
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
 * True when getClaims() could not check the token locally and asked the Auth
 * server instead, through getUser(token). auth-js does that for a token with no
 * algorithm, a symmetric (HS*) algorithm, or no key id, which is what projects
 * on the legacy JWT secret issue. A success then already means the session
 * exists, so confirmUser would only repeat the same request. Any other header,
 * or none, returns false, so the proxy asks. proxy-ssr.test.ts pins this
 * auth-js behaviour with a revoked HS256 session.
 */
function claimsCameFromAuthServer(header: { alg?: string; kid?: string } | undefined): boolean {
  if (!header) return false
  return !header.alg || header.alg.startsWith('HS') || !header.kid
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
  const origin = request.nextUrl.origin
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
  let confirmedByAuthServer = false
  try {
    const { data } = await supabase.auth.getClaims()
    hasClaims = typeof data?.claims?.sub === 'string'
    confirmedByAuthServer = hasClaims && claimsCameFromAuthServer(data?.header)
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
  // This costs one Auth round trip per protected page request, including
  // prefetches. It is skipped only when getClaims() already made that same
  // request (claimsCameFromAuthServer), so no request asks twice.
  let signedIn = hasClaims
  if (hasClaims && !confirmedByAuthServer && (isLogin || (!isPublic && !isApi))) {
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
    const loginUrl = new URL(LOGIN_PATH, origin)
    const next = safeNextPath(pathname + request.nextUrl.search, origin)
    if (next) loginUrl.searchParams.set(NEXT_PARAM, next)
    return carrySession(response, NextResponse.redirect(loginUrl))
  }

  if (signedIn && isLogin) {
    const next = safeNextPath(request.nextUrl.searchParams.get(NEXT_PARAM), origin)
    let destination = new URL(next ?? HOME_PATH, origin)
    // safeNextPath already guarantees a same-origin path; this is a second
    // check on the URL that is actually sent.
    if (destination.origin !== origin) destination = new URL(HOME_PATH, origin)
    return carrySession(response, NextResponse.redirect(destination))
  }

  return response
}
