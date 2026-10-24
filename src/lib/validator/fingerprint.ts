import { createHash } from 'node:crypto'
import { normalize } from '@/lib/validator/normalize'

/**
 * The prompt fingerprint for the exact-replay blocklist (docs/ARCHITECTURE.md
 * sections 8.1 and 9.6; CH-6b).
 *
 * fingerprint(input) is the lowercase hex SHA-256 of FINGERPRINT_PREFIX
 * followed by the letter-and-digit token runs of normalize(input), joined by
 * single spaces. Case, whitespace, punctuation, zero-width, accent, and
 * confusable variants of one prompt therefore share a fingerprint, while
 * different prompts do not. Tokens keep every script, so two different
 * messages written entirely in Japanese or Arabic get different
 * fingerprints. The function is pure.
 */

export const FINGERPRINT_PREFIX = 'pp-fp-v1:'

/** The canonical token string a fingerprint hashes, without the prefix. */
export function fingerprintSource(input: string): string {
  return normalize(input).tokens.join(' ')
}

export function fingerprint(input: string): string {
  if (typeof input !== 'string') throw new TypeError('fingerprint() needs a string.')
  return createHash('sha256').update(FINGERPRINT_PREFIX + fingerprintSource(input), 'utf8').digest('hex')
}

Object.freeze(fingerprintSource)
Object.freeze(fingerprint)
