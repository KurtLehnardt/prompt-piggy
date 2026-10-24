import 'server-only'
import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of a presented secret with the expected one
 * (docs/ARCHITECTURE.md section 11, T22). It is skylite's cron check, made
 * reusable: the cron routes (PP-29) and the projector token at /live/enter
 * (PP-21) both call it.
 *
 * - Byte lengths are compared, never string lengths. `String.length` counts
 *   UTF-16 code units, so a multibyte value could pass a length check and then
 *   make `timingSafeEqual` throw a RangeError.
 * - It never throws: a missing, non-string, or multibyte value returns false.
 * - It fails closed: an empty or missing expected value matches nothing, not
 *   even an empty presented value, so an unset secret can never be satisfied
 *   (PR #6 review, M1).
 *
 * The length check returns early, so the time taken reveals whether the
 * lengths match, but never anything about the content. That is the same
 * trade-off skylite makes; the secrets are long random strings.
 */
export function safeEqual(presented: unknown, expected: unknown): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  if (presented === '' || expected === '') return false
  try {
    const presentedBytes = Buffer.from(presented, 'utf8')
    const expectedBytes = Buffer.from(expected, 'utf8')
    if (presentedBytes.length !== expectedBytes.length) return false
    return timingSafeEqual(presentedBytes, expectedBytes)
  } catch {
    return false
  }
}
