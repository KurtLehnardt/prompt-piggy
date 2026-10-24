import type { DeepReadonly } from '@/lib/config/deep-freeze'
import { CAPS } from '@/lib/rules/caps'
import type { HardeningProposalV1, RuleSetV1 } from '@/lib/rules/schema'

/**
 * Canonical form of rule sets and proposals (docs/ARCHITECTURE.md sections 6.1,
 * 6.3, and 6.4).
 *
 * Both schemas are flat (HC1): every value is a boolean, a number, a string,
 * or the one string array `block_keywords`. The canonical form puts the keys
 * in code-unit order and sorts every array, and the canonical JSON is the
 * compact JSON.stringify of that form. Keywords are ASCII, so code-unit order
 * equals byte order and SQL `collate "C"` order. The functions are pure.
 */

type Flat = DeepReadonly<RuleSetV1> | DeepReadonly<HardeningProposalV1>

/** Orders strings by UTF-16 code unit, independent of locale. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Normalizes a candidate keyword the way section 6.3 measures it: NFKC,
 * lowercase, every whitespace run collapsed to one space, and trimmed. The
 * schemas reject any keyword that is not already in this form, so callers
 * (the proposal sanitizer, PP-20) normalize first and then validate.
 */
export function normalizeKeyword(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Returns a new object with the keys in code-unit order and every array value
 * copied and sorted. The input is not changed.
 */
export function canonicalize<T extends Flat>(value: T): T {
  const source = value as Readonly<Record<string, unknown>>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort(compareCodeUnits)) {
    const field = source[key]
    out[key] = Array.isArray(field) ? sortedCopy(field) : field
  }
  return out as T
}

/** The canonical JSON of a rule set or proposal. */
export function canonicalJson(value: Flat): string {
  return JSON.stringify(canonicalize(value))
}

/** The number of bytes in the UTF-8 encoding of a string. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** The UTF-8 size of a rule set's canonical JSON. */
export function canonicalByteLength(value: Flat): number {
  return utf8Bytes(canonicalJson(value))
}

/**
 * True when the canonical JSON of a rule-set-shaped value is at most
 * CAPS.ruleSetBytes bytes. The schema calls it on values that may have failed
 * other checks, so it accepts anything and fails closed when the value cannot
 * be serialized.
 */
export function isWithinRuleSetByteCap(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true
  try {
    return canonicalByteLength(value as Flat) <= CAPS.ruleSetBytes
  } catch {
    return false
  }
}

/** The lowercase hex SHA-256 of a rule set's or proposal's canonical JSON. */
export async function canonicalSha256(value: Flat): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sortedCopy(values: readonly unknown[]): unknown[] {
  return [...values].sort((a, b) => compareCodeUnits(String(a), String(b)))
}
