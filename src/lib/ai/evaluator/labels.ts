import type { DecideResult } from '@/lib/ai/decisions/schema'
import type { AttackTechnique } from '@/lib/config/techniques'
import { BLOCK_REASON_TECHNIQUES } from '@/lib/validator/reasons'

/**
 * Technique labels (docs/ARCHITECTURE.md section 8.2; CH-6b).
 *
 * Labels are display data only. They never change an outcome and never feed
 * hardening. Both mappings are fixed tables, so the same input always gets
 * the same label.
 */

/**
 * The label of each validator reason code. This is PP-08's fixed table
 * (src/lib/validator/reasons.ts), reused so the two can never drift: the
 * detector families map to their techniques, and the input checks, `keyword`,
 * and `replayed_breach` map to `unclassified`.
 */
export const REASON_TECHNIQUES = BLOCK_REASON_TECHNIQUES

export type MappedReasonCode = keyof typeof REASON_TECHNIQUES

function isMappedReason(code: string): code is MappedReasonCode {
  return Object.prototype.hasOwnProperty.call(REASON_TECHNIQUES, code)
}

/**
 * The label of a validator or fingerprint block: the technique of the first
 * known reason code, as PP-08's blockTechnique() gives it, or `unclassified`
 * when no code is known. Unknown strings are skipped, never looked up on the
 * object prototype.
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
