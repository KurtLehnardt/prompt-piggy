import { HOME_PATH, safeNextPath } from '@/lib/supabase/proxy'

/**
 * Open-redirect defense for the OAuth callback's `next` parameter
 * (docs/ARCHITECTURE.md section 11, T17; REVIEW-1 R1-10).
 *
 * The proxy already keeps only a same-origin, path-only `next` when it sends a
 * signed-out visitor to /login, but anyone can link straight to
 * /auth/callback?next=..., so the callback validates `next` again here
 * (defense in depth, PR #2 review).
 *
 * A candidate is accepted only when all of these hold, and otherwise the
 * result is the default path, /play:
 *
 * 1. Before and after one percent-decode, it is 1 to 2048 characters drawn
 *    only from `[A-Za-z0-9/_\-.?=&%]`. That excludes every ASCII control
 *    character (U+0000 to U+001F and U+007F), whitespace, the backslash, ":"
 *    (so no scheme), "@", and "#". The decoded form catches encoded controls
 *    such as %09 and %0d%0a, which the URL parser would otherwise drop.
 * 2. Before and after that decode, it starts with exactly one "/", contains
 *    no percent-encoded slash or backslash (%2F, %5C), and has no "." or ".."
 *    path segment, encoded or not.
 * 3. `new URL(candidate, 'https://x.invalid')` keeps that probe origin.
 * 4. PP-01's safeNextPath() accepts it. That is the same check the proxy
 *    uses: it re-checks the pathname and search the URL parser produces
 *    (the dot-segment and encoded-slash cases), requires them to parse back to
 *    themselves, and rejects /login and /api paths.
 *
 * safeRedirect() then returns the app origin plus that pathname and search,
 * so the result can never name another host, carry credentials, or keep a
 * fragment.
 */

/** Where the callback sends a player when `next` is missing or rejected. */
export const DEFAULT_REDIRECT_PATH = HOME_PATH

const MAX_LENGTH = 2048
const PROBE_ORIGIN = 'https://x.invalid'

/** The only characters a redirect path may contain (T17). */
const ALLOWED_CHARACTERS = /^[A-Za-z0-9/_\-.?=&%]+$/
/** ASCII control characters: U+0000 to U+001F and U+007F. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
/** A percent-encoded slash or backslash. */
const ENCODED_SEPARATOR = /%(?:2f|5c)/i
/** A "." or ".." path segment, with either dot possibly written as %2e. */
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i

function pathPart(value: string): string {
  const query = value.indexOf('?')
  return query === -1 ? value : value.slice(0, query)
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function parseUrl(input: string, base?: string): URL | null {
  try {
    return new URL(input, base)
  } catch {
    return null
  }
}

/** Rules 1 and 2 for one form of the candidate. */
function passesTextChecks(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_LENGTH &&
    !CONTROL_CHARACTER.test(value) &&
    ALLOWED_CHARACTERS.test(value) &&
    !ENCODED_SEPARATOR.test(value) &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !DOT_SEGMENT.test(pathPart(value))
  )
}

/**
 * Returns `next` as a safe same-origin pathname plus search, or the default
 * path /play. It never throws.
 */
export function safeRedirectPath(next: unknown): string {
  if (typeof next !== 'string') return DEFAULT_REDIRECT_PATH

  const decoded = decodeOnce(next)
  if (decoded === null || !passesTextChecks(next) || !passesTextChecks(decoded)) {
    return DEFAULT_REDIRECT_PATH
  }

  const probe = parseUrl(next, PROBE_ORIGIN)
  if (!probe || probe.origin !== PROBE_ORIGIN) return DEFAULT_REDIRECT_PATH

  const target = safeNextPath(next, PROBE_ORIGIN)
  if (!target || !passesTextChecks(target)) return DEFAULT_REDIRECT_PATH
  return target
}

/**
 * Returns the absolute URL to redirect to: `appOrigin` plus the validated
 * pathname and search of `next`, or `appOrigin` plus /play. `appOrigin` is the
 * origin the request was served on, which is the one the session cookies
 * belong to. It throws only when `appOrigin` is not an http(s) origin, which
 * is a programming error.
 */
export function safeRedirect(next: unknown, appOrigin: string): URL {
  const origin = parseUrl(appOrigin)
  if (!origin || (origin.protocol !== 'https:' && origin.protocol !== 'http:')) {
    throw new TypeError('safeRedirect needs an http or https app origin.')
  }
  const url = new URL(safeRedirectPath(next), origin.origin)
  // safeRedirectPath() already guarantees a same-origin path; this checks the
  // URL that is actually returned.
  if (url.origin !== origin.origin) return new URL(DEFAULT_REDIRECT_PATH, origin.origin)
  return url
}
