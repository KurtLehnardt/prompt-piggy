import 'server-only'
import { randomBytes } from 'node:crypto'
import { deepFreeze } from '@/lib/config/deep-freeze'

/**
 * Per-attempt canary tokens (docs/ARCHITECTURE.md sections 8.3 and 11, T3).
 *
 * A canary is `PP-` followed by 20 Crockford base32 characters that carry 100
 * bits from `crypto.randomBytes`. The attempt flow generates a fresh one for
 * every attempt, places it in the Core LLM's instructions as a confidential
 * reference, and scans the reply for it with `detectCanaryLeak`. It has no
 * value of its own and is never stored in clear, never logged, and never
 * hardcoded: tests use obviously fake values or values generated at run time.
 *
 * The module is pure apart from reading the system random source, holds no
 * state, and exports only frozen values (HC3).
 */

/** The Crockford base32 alphabet: digits and capitals without I, L, O, and U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const CANARY_PREFIX = 'PP-'

/** Number of base32 characters after the prefix (100 bits of entropy). */
export const CANARY_BODY_LENGTH = 20

/** The full shape of a canary. The regular expression is not global, so it holds no lastIndex state. */
export const CANARY_PATTERN = Object.freeze(/^PP-[0-9A-HJKMNP-TV-Z]{20}$/)

const BITS_PER_CHAR = 5
/** 100 bits need 13 bytes; the 4 spare bits of the last byte are discarded. */
const RANDOM_BYTES = Math.ceil((CANARY_BODY_LENGTH * BITS_PER_CHAR) / 8)

export const CANARY_FORMAT = deepFreeze({
  prefix: CANARY_PREFIX,
  bodyLength: CANARY_BODY_LENGTH,
  alphabet: CROCKFORD_ALPHABET,
  entropyBits: CANARY_BODY_LENGTH * BITS_PER_CHAR,
  randomBytes: RANDOM_BYTES,
})

/** Returns a new canary built from `crypto.randomBytes`. Every call is independent. */
export function canary(): string {
  return CANARY_PREFIX + encodeCrockford(randomBytes(RANDOM_BYTES), CANARY_BODY_LENGTH)
}

/** True when the value has the exact canary shape. */
export function isCanary(value: unknown): value is string {
  return typeof value === 'string' && CANARY_PATTERN.test(value)
}

/** The 20-character body of a canary, without the `PP-` prefix. */
export function canaryBody(value: string): string {
  if (!isCanary(value)) throw new TypeError('canaryBody() needs a value with the canary shape.')
  return value.slice(CANARY_PREFIX.length)
}

/**
 * Encodes the leading `length * 5` bits of `bytes` as Crockford base32,
 * most significant bit first. Each 5-bit group maps to one character, so
 * uniformly random bytes give uniformly random characters.
 */
function encodeCrockford(bytes: Uint8Array, length: number): string {
  let out = ''
  let buffer = 0
  let bufferedBits = 0
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff
    bufferedBits += 8
    while (bufferedBits >= BITS_PER_CHAR && out.length < length) {
      bufferedBits -= BITS_PER_CHAR
      out += CROCKFORD_ALPHABET[(buffer >>> bufferedBits) & 0b11111]
    }
  }
  if (out.length !== length) throw new Error('Not enough random bytes for the canary body.')
  return out
}

Object.freeze(canary)
Object.freeze(isCanary)
Object.freeze(canaryBody)
