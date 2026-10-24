import 'server-only'
import { deepFreeze } from '@/lib/config/deep-freeze'
import { isNonce } from '@/lib/security/nonce'

/**
 * Nonce-tag JSON encapsulation of untrusted text (HARDENING_CONSTRAINTS.md
 * constraint 2 and the orchestrator additions, HC2 and HC-A2;
 * docs/ARCHITECTURE.md sections 8.3 and 8.5, T5).
 *
 * The Core LLM wraps the attacker's message as `customer_message`, and the
 * Hardening Engine wraps the breach envelope as `untrusted_breach`:
 *
 *   <customer_message_{nonce}>
 *   "the attacker text, JSON-encoded, with <, >, and & escapes"
 *   </customer_message_{nonce}>
 *
 * Delimiters alone fail when the payload contains the closing tag, so two
 * layers apply together:
 *
 *   - The tag name carries a fresh 128-bit nonce per request, so the attacker
 *     cannot know the closing tag in advance.
 *   - The payload is JSON-encoded on one line, and every `<`, `>`, and `&` is
 *     replaced by its JSON unicode escape. The payload therefore contains no
 *     angle bracket at all and cannot form any tag, even one that guessed the
 *     nonce. U+2028, U+2029, and U+0085 are escaped as well, so no character
 *     that some readers treat as a line break survives inside the payload line.
 *
 * JSON.parse of the middle line returns the original value exactly. The
 * prompt that surrounds the envelope must still tell the model that the
 * tagged content is untrusted, adversarial, passive data (HC2); that wording
 * lives with each prompt (src/lib/ai/core and src/lib/hardening/engine).
 *
 * The module is pure, holds no state, and exports only frozen values (HC3).
 */

/** Tag prefixes are code constants: lowercase words joined by underscores. */
export const TAG_PREFIX_PATTERN = Object.freeze(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)

export const MAX_TAG_PREFIX_LENGTH = 48

/** The prefixes the application uses (ARCHITECTURE sections 8.3 and 8.5). */
export const TAG_PREFIXES = deepFreeze({
  customerMessage: 'customer_message',
  untrustedBreach: 'untrusted_breach',
} as const)

/** Characters replaced by their JSON unicode escapes inside the payload line. */
export const JSON_ESCAPES: Readonly<Record<string, string>> = deepFreeze({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
  '\u0085': '\\u0085',
})

/** A JSON value that the encapsulation can carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** The full tag name `{prefix}_{nonce}`; throws on a malformed prefix or nonce. */
export function tagName(prefix: string, nonce: string): string {
  if (
    typeof prefix !== 'string' ||
    prefix.length > MAX_TAG_PREFIX_LENGTH ||
    !TAG_PREFIX_PATTERN.test(prefix)
  ) {
    throw new TypeError('The tag prefix must be lowercase words joined by underscores.')
  }
  if (!isNonce(nonce)) throw new TypeError('The nonce must be 32 lowercase hex characters.')
  return `${prefix}_${nonce}`
}

/**
 * JSON-encodes a value on one line and replaces `<`, `>`, `&`, U+2028,
 * U+2029, and U+0085 with their JSON unicode escapes. The result is valid
 * JSON that parses back to the same value.
 */
export function encodeUntrustedJson(value: JsonValue): string {
  const json = JSON.stringify(value)
  if (typeof json !== 'string') throw new TypeError('The value cannot be JSON-encoded.')
  const escaped = json.replace(/[<>&\u2028\u2029\u0085]/g, (char) => JSON_ESCAPES[char])
  // JSON.stringify already escapes every control character, including line
  // feeds; this check keeps the one-line, bracket-free guarantee explicit.
  if (/[<>\n\r]/.test(escaped)) throw new Error('Encoded payload kept a forbidden character.')
  return escaped
}

/** Wraps an already encoded payload line in the nonce tags. */
function wrap(encoded: string, nonce: string, prefix: string): string {
  const name = tagName(prefix, nonce)
  return `<${name}>\n${encoded}\n</${name}>`
}

/**
 * Wraps untrusted text: the opening tag `<{prefix}_{nonce}>`, a newline, the
 * JSON-encoded text with `<`, `>`, and `&` escaped, a newline, and the
 * closing tag.
 */
export function encapsulate(text: string, nonce: string, prefix: string): string {
  if (typeof text !== 'string') throw new TypeError('encapsulate() needs a string payload.')
  return wrap(encodeUntrustedJson(text), nonce, prefix)
}

/**
 * The same envelope for a JSON object or array, such as the Hardening
 * Engine's breach envelope (ARCHITECTURE section 8.5), whose string fields
 * hold attacker text.
 */
export function encapsulateJson(value: JsonValue, nonce: string, prefix: string): string {
  return wrap(encodeUntrustedJson(value), nonce, prefix)
}

Object.freeze(tagName)
Object.freeze(encodeUntrustedJson)
Object.freeze(encapsulate)
Object.freeze(encapsulateJson)
