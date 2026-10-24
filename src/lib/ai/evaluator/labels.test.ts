import { describe, expect, it } from 'vitest'
import { REASON_TECHNIQUES, techniqueForDecisions, techniqueForReasons } from '@/lib/ai/evaluator/labels'
import { isDeepFrozen } from '@/lib/config/deep-freeze'
import { DETECTOR_FAMILIES } from '@/lib/config/detector-families'
import { ATTACK_TECHNIQUES, ENGINE_TECHNIQUES } from '@/lib/config/techniques'
import { BLOCK_REASON_TECHNIQUES, blockTechnique, REASON_CODES } from '@/lib/validator/reasons'

/** src/lib/ai/evaluator/labels.ts (docs/ARCHITECTURE.md section 8.2; CH-6b). */

describe('techniqueForReasons', () => {
  it('maps every detector family and the keyword and replay codes deterministically', () => {
    for (const family of DETECTOR_FAMILIES) {
      expect(ATTACK_TECHNIQUES).toContain(REASON_TECHNIQUES[family])
      expect(techniqueForReasons([family])).toBe(REASON_TECHNIQUES[family])
    }
    expect(techniqueForReasons(['roleplay'])).toBe('roleplay_persona')
    expect(techniqueForReasons(['authority'])).toBe('authority_impersonation')
    expect(techniqueForReasons(['decode'])).toBe('encoded_smuggling')
    expect(techniqueForReasons(['tool'])).toBe('tool_or_mcp_takeover')
    expect(techniqueForReasons(['keyword'])).toBe('unclassified')
    expect(techniqueForReasons(['replayed_breach'])).toBe('unclassified')
    expect(isDeepFrozen(REASON_TECHNIQUES)).toBe(true)
  })

  it("reuses PP-08's table and agrees with blockTechnique on every reason code", () => {
    expect(REASON_TECHNIQUES).toBe(BLOCK_REASON_TECHNIQUES)
    for (const code of [...REASON_CODES, 'replayed_breach' as const]) {
      expect(techniqueForReasons([code])).toBe(blockTechnique([code]))
    }
  })

  it('uses the first mapped reason and falls back to unclassified', () => {
    expect(techniqueForReasons(['delimiter', 'roleplay'])).toBe('delimiter_injection')
    expect(techniqueForReasons(['too_long'])).toBe('unclassified')
    expect(techniqueForReasons(['not_a_code', 'roleplay'])).toBe('roleplay_persona')
    expect(techniqueForReasons([])).toBe('unclassified')
    expect(techniqueForReasons(['__proto__', 'constructor'])).toBe('unclassified')
    expect(techniqueForReasons(['replayed_breach', 'roleplay'])).toBe('unclassified')
  })
})

describe('techniqueForDecisions', () => {
  it('passes a choice through and maps an unavailable result to unknown', () => {
    for (const technique of ENGINE_TECHNIQUES) {
      expect(techniqueForDecisions({ kind: 'ok', probability: 0.5, technique, usage: null })).toBe(technique)
    }
    expect(techniqueForDecisions({ kind: 'unavailable', reason: 'timeout', status: null })).toBe('unknown')
    expect(techniqueForDecisions({ kind: 'upstream_config', status: 401, code: null })).toBe('unknown')
    expect(techniqueForDecisions({ kind: 'refusal', usage: null })).toBe('unclassified')
    expect(techniqueForDecisions({ kind: 'rejected', status: 400, code: 'invalid_prompt' })).toBe('unclassified')
  })
})
