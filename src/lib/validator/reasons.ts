import { deepFreeze } from '@/lib/config/deep-freeze'
import { DETECTOR_FAMILIES, type DetectorFamily } from '@/lib/config/detector-families'
import type { EngineTechnique } from '@/lib/config/techniques'

/**
 * Reason and signal codes of the Dynamic Validator (docs/ARCHITECTURE.md
 * sections 8.1 and 8.2).
 *
 * A result carries these codes only, never matched text, so it is safe to
 * store in `attempts.validator_reasons` and `validator_signals` and to log.
 *
 * - Reasons explain a block: an input check (`too_long`, `control_chars`,
 *   `invalid_input`), a detector family whose flag is on, or `keyword` for a
 *   matched `block_keywords` entry.
 * - Signals are detector families that matched while their flag was off.
 *   They feed the display label and the Hardening Engine's context only.
 */

export const INPUT_REASON_CODES = deepFreeze(['too_long', 'control_chars', 'invalid_input'] as const)

export type InputReasonCode = (typeof INPUT_REASON_CODES)[number]

export const REASON_CODES = deepFreeze([...INPUT_REASON_CODES, ...DETECTOR_FAMILIES, 'keyword'] as const)

export type ReasonCode = InputReasonCode | DetectorFamily | 'keyword'

export const SIGNAL_CODES = deepFreeze([...DETECTOR_FAMILIES] as const)

export type SignalCode = DetectorFamily

/**
 * The display label of a blocked attempt, from its first reason code (section
 * 8.2, "Label for blocked attempts"). No OpenAI call is made for a validator
 * or fingerprint block, so this fixed table stands in for the Decisions
 * label. `replayed_breach` is the attempt service's fingerprint block.
 * Labels are display data only and never feed hardening (CH-6b).
 */
export const BLOCK_REASON_TECHNIQUES = deepFreeze({
  too_long: 'unclassified',
  control_chars: 'unclassified',
  invalid_input: 'unclassified',
  roleplay: 'roleplay_persona',
  authority: 'authority_impersonation',
  override: 'instruction_override',
  delimiter: 'delimiter_injection',
  decode: 'encoded_smuggling',
  tool: 'tool_or_mcp_takeover',
  deferred: 'deferred_trigger',
  mixed_script: 'multilingual_obfuscation',
  hypothetical: 'roleplay_persona',
  keyword: 'unclassified',
  replayed_breach: 'unclassified',
} as const satisfies Record<ReasonCode | 'replayed_breach', EngineTechnique>)

/** The technique label for a block, from its reason codes; `unclassified` when there are none. */
export function blockTechnique(reasons: readonly (ReasonCode | 'replayed_breach')[]): EngineTechnique {
  const first = reasons[0]
  return first === undefined ? 'unclassified' : BLOCK_REASON_TECHNIQUES[first]
}

Object.freeze(blockTechnique)
