import type { DecideResult } from '@/lib/ai/decisions/schema'
import { deepFreeze } from '@/lib/config/deep-freeze'
import type { DetectorFamily } from '@/lib/config/detector-families'
import type { AttackTechnique } from '@/lib/config/techniques'

/**
 * Technique labels (docs/ARCHITECTURE.md section 8.2; CH-6b).
 *
 * Labels are display data only. They never change an outcome and never feed
 * hardening. Both mappings are fixed tables, so the same input always gets
 * the same label.
 */

/** The label of each validator reason code. Codes not listed here are `unclassified`. */
export const REASON_TECHNIQUES = deepFreeze({
  roleplay: 'roleplay_persona',
  authority: 'authority_impersonation',
  override: 'instruction_override',
  delimiter: 'delimiter_injection',
  decode: 'encoded_smuggling',
  tool: 'tool_or_mcp_takeover',
  deferred: 'deferred_trigger',
  mixed_script: 'multilingual_obfuscation',
  // Hypothetical and fictional framing asks the teller to act inside a story,
  // the closest of the 11 classes.
  hypothetical: 'roleplay_persona',
  // A matched block keyword or an exact replay of a past breach says nothing
  // about the technique (section 8.2).
  keyword: 'unclassified',
  replayed_breach: 'unclassified',
} as const satisfies Record<DetectorFamily | 'keyword' | 'replayed_breach', AttackTechnique>)

export type MappedReasonCode = keyof typeof REASON_TECHNIQUES

function isMappedReason(code: string): code is MappedReasonCode {
  return Object.prototype.hasOwnProperty.call(REASON_TECHNIQUES, code)
}

/**
 * The label of a validator or fingerprint block: the technique of the first
 * reason code that has one, or `unclassified` (for example for `too_long`).
 */
export function techniqueForReasons(reasons: readonly string[]): AttackTechnique {
  for (const code of reasons) {
    if (isMappedReason(code)) return REASON_TECHNIQUES[code]
  }
  return 'unclassified'
}

/**
 * The label of a Decisions result: its choice when it answered, `unknown`
 * when it was unavailable or misconfigured (no answer at all), and
 * `unclassified` for a refusal or a rejected input.
 */
export function techniqueForDecisions(result: DecideResult): AttackTechnique {
  switch (result.kind) {
    case 'ok':
      return result.technique
    case 'unavailable':
    case 'upstream_config':
      return 'unknown'
    case 'refusal':
    case 'rejected':
      return 'unclassified'
  }
}
