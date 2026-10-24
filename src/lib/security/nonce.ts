import 'server-only'
import { randomBytes } from 'node:crypto'

/**
 * Per-request nonces for the tag names that wrap untrusted text
 * (HARDENING_CONSTRAINTS.md constraint 2 and the orchestrator additions,
 * HC-A2; docs/ARCHITECTURE.md sections 8.3 and 8.5, T5).
 *
 * A nonce is 128 bits from `crypto.randomBytes` written as 32 lowercase hex
 * characters. The Core LLM and the Hardening Engine each create a new one per
 * request, so an attacker cannot know the closing tag in advance.
 *
 * The module holds no state and exports only frozen values (HC3).
 */

export const NONCE_BYTES = 16

export const NONCE_HEX_LENGTH = NONCE_BYTES * 2

/** The regular expression is not global, so it holds no lastIndex state. */
export const NONCE_PATTERN = Object.freeze(/^[0-9a-f]{32}$/)

/** Returns 32 lowercase hex characters (128 random bits). */
export function nonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex')
}

/** True when the value has the exact nonce shape. */
export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE_PATTERN.test(value)
}

Object.freeze(nonce)
Object.freeze(isNonce)
