import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { requireEnv } from '@/lib/env'

/**
 * The projector cookie for /live (docs/ARCHITECTURE.md sections 7 and 12.2;
 * threat T32; REVIEW-2 R2-07; REVIEW-3 R3-10; PR #6 review, M1).
 *
 * /live/enter compares `?k=` with LIVE_VIEW_TOKEN and, on a match, sets the
 * `pp_live` cookie to `v1.<expiry>.<mac>`:
 *
 * - `<expiry>` is the Unix time in whole seconds when the cookie stops
 *   working, 12 hours after it was issued.
 * - `<mac>` is the unpadded base64url HMAC-SHA256 of `v1.<expiry>`, keyed by
 *   LIVE_VIEW_TOKEN.
 *
 * The cookie never holds the token itself, and rotating the token invalidates
 * every cookie issued under the old one. The MAC is compared with
 * crypto.timingSafeEqual.
 *
 * LIVE_VIEW_TOKEN is read only through requireEnv() at the point of use. An
 * unset, empty, or invalid value, or any problem reading the environment,
 * closes /live: nothing verifies and nothing is signed (fail closed). No
 * function here logs or returns the token, the `k` parameter, or the cookie
 * value.
 */

export const PROJECTOR_COOKIE = 'pp_live'
export const PROJECTOR_COOKIE_PATH = '/live'
/** 12 hours, in seconds. */
export const PROJECTOR_COOKIE_MAX_AGE = 43_200

const VERSION = 'v1'
/** v1.<10 to 12 digit expiry>.<43 base64url characters: 32 bytes unpadded>. */
const COOKIE_SHAPE = /^v1\.(\d{10,12})\.([A-Za-z0-9_-]{43})$/
/** A cookie may claim at most this much clock skew beyond its lifetime. */
const MAX_FUTURE_SKEW_SECONDS = 300

/**
 * The projector token, or null when it is unset, empty, or the server
 * environment cannot be read. Never throws and never logs.
 */
export function readProjectorToken(): string | null {
  try {
    const token = requireEnv('LIVE_VIEW_TOKEN').LIVE_VIEW_TOKEN
    return typeof token === 'string' && token !== '' ? token : null
  } catch {
    return null
  }
}

function macOf(expirySeconds: number, key: string): Buffer {
  return createHmac('sha256', key).update(`${VERSION}.${expirySeconds}`).digest()
}

function nowSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000)
}

/** Builds a cookie value that expires PROJECTOR_COOKIE_MAX_AGE seconds after `nowMs`. */
export function signProjectorCookie(key: string, nowMs: number = Date.now()): string {
  if (typeof key !== 'string' || key === '') throw new Error('The projector cookie needs a key.')
  const expiry = nowSeconds(nowMs) + PROJECTOR_COOKIE_MAX_AGE
  return `${VERSION}.${expiry}.${macOf(expiry, key).toString('base64url')}`
}

/**
 * True only for a well-formed, unexpired cookie whose MAC matches `key`.
 * A missing key, a malformed value, an expired or far-future expiry, a wrong
 * key, and a tampered expiry all return false. Never throws.
 */
export function verifyProjectorCookie(value: unknown, key: unknown, nowMs: number = Date.now()): boolean {
  if (typeof key !== 'string' || key === '') return false
  if (typeof value !== 'string' || value.length > 128) return false
  const match = COOKIE_SHAPE.exec(value)
  if (!match) return false

  const expiry = Number(match[1])
  const now = nowSeconds(nowMs)
  if (!Number.isSafeInteger(expiry) || expiry <= now) return false
  if (expiry > now + PROJECTOR_COOKIE_MAX_AGE + MAX_FUTURE_SKEW_SECONDS) return false

  try {
    const presented = Buffer.from(match[2], 'base64url')
    const expected = macOf(expiry, key)
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  } catch {
    return false
  }
}

/** Verifies a cookie value against the configured token. False whenever /live is closed. */
export function hasProjectorAccess(cookieValue: string | undefined | null, nowMs: number = Date.now()): boolean {
  const token = readProjectorToken()
  if (token === null) return false
  return verifyProjectorCookie(cookieValue, token, nowMs)
}

/** The Set-Cookie options for the projector cookie: HttpOnly, Secure, SameSite=Strict, Path=/live, 12 hours. */
export const PROJECTOR_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: PROJECTOR_COOKIE_PATH,
  maxAge: PROJECTOR_COOKIE_MAX_AGE,
} as const)
