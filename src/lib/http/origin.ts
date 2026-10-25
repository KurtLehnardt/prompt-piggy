import 'server-only'
import { getEnv } from '@/lib/env'
import { readAppOrigin } from '@/lib/public-env'

/**
 * The CSRF guard for state-changing routes (docs/ARCHITECTURE.md section 7,
 * R1-04, R2-10). A route answers 403 `forbidden` when assertSameOrigin()
 * returns false.
 *
 * The configured origins are the NEXT_PUBLIC_APP_URL origin and, only on a
 * Vercel preview deployment (VERCEL_ENV === 'preview'), the per-deployment
 * URL https://VERCEL_URL and the branch alias https://VERCEL_BRANCH_URL.
 * Next.js inlines NEXT_PUBLIC_APP_URL at build time, so a deployment built
 * before the variable was set has no app origin here; requestOrigin() covers
 * that case.
 */
export function allowedOrigins(): ReadonlySet<string> {
  const origins = new Set<string>()
  const appOrigin = readAppOrigin()
  if (appOrigin) origins.add(appOrigin)

  const env = getEnv()
  if (env.VERCEL_ENV === 'preview') {
    for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
      const origin = host ? originOf(`https://${host}`) : null
      if (origin) origins.add(origin)
    }
  }
  return origins
}

function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** The first entry of a comma-separated forwarding header, or null when it is absent or empty. */
function firstValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim()
  return first ? first : null
}

/** A bare host with an optional port: a DNS name, IPv4 address, or bracketed IPv6 address. */
const BARE_HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d{1,5})?$/i

/**
 * The origin this request was sent to, from the Host the browser used:
 * `x-forwarded-host` (set by the Vercel edge) or else `host`, and
 * `x-forwarded-proto` or else the request URL's scheme. Returns null when the
 * host is not a bare host[:port] or the scheme is not http or https. It is
 * only ever compared with the Origin header, never used as the target of an
 * outbound request (section 8.6).
 */
function requestOrigin(request: Request): string | null {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  const host = firstValue(request.headers.get('x-forwarded-host')) ?? firstValue(request.headers.get('host')) ?? url.host
  const proto = (firstValue(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(/:$/, '')).toLowerCase()
  if (proto !== 'http' && proto !== 'https') return null
  if (!BARE_HOST.test(host)) return null
  return originOf(`${proto}://${host}`)
}

/**
 * True only when the request's Origin header is exactly the origin the
 * request was sent to (requestOrigin) or one of allowedOrigins(). A missing
 * Origin, `Origin: null`, a header that is not a bare origin, an unparseable
 * Host, and every other origin are refused, so the check fails closed. The
 * Referer header is never used.
 *
 * Comparing Origin with the request's own Host is a sound CSRF check. The
 * browser sets both headers itself, and page script cannot change them. A
 * cross-site page can make the victim's browser send our Host only together
 * with the page's own Origin, and it cannot add `x-forwarded-host` without a
 * CORS preflight that these routes never approve. A client that does forge
 * the headers (curl, a script) is not a browser, so it does not carry the
 * victim's session cookies. This path keeps the guard working on every
 * hostname the deployment answers on, without depending on NEXT_PUBLIC_APP_URL
 * having been set when the deployment was built.
 */
export function assertSameOrigin(request: Request): boolean {
  const header = request.headers.get('origin')
  if (!header) return false
  const origin = originOf(header)
  // An Origin header is scheme://host[:port] and nothing else.
  if (!origin || origin !== header.toLowerCase()) return false
  if (origin === requestOrigin(request)) return true
  return allowedOrigins().has(origin)
}
