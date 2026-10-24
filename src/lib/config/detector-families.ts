import { deepFreeze } from '@/lib/config/deep-freeze'

/**
 * The nine deterministic detector families of the Dynamic Validator, in the
 * flag order of docs/ARCHITECTURE.md section 6.2. Each rule-set flag switches
 * one family from "signal" to "block"; src/lib/rules/flags.ts (PP-06) maps the
 * flags to these names.
 *
 * | Family         | Flag                              |
 * |----------------|-----------------------------------|
 * | `roleplay`     | `reject_roleplay_archetypes`      |
 * | `authority`    | `reject_authority_claims`         |
 * | `override`     | `reject_instruction_override`     |
 * | `delimiter`    | `reject_delimiter_tokens`         |
 * | `decode`       | `reject_encoded_payloads`         |
 * | `tool`         | `reject_tool_invocation_language` |
 * | `deferred`     | `reject_deferred_instructions`    |
 * | `mixed_script` | `reject_mixed_script_obfuscation` |
 * | `hypothetical` | `reject_hypothetical_framing`     |
 *
 * The names double as the validator's reason and signal codes, and they are
 * the only keys allowed in a level 4 or 5 payload's `extra_detector_phrases`
 * (section 6.2, R2-12). The SQL mirror `level_secret_payload_ok` (PP-07) must
 * accept exactly these keys.
 */
export const DETECTOR_FAMILIES = deepFreeze([
  'roleplay',
  'authority',
  'override',
  'delimiter',
  'decode',
  'tool',
  'deferred',
  'mixed_script',
  'hypothetical',
] as const)

export type DetectorFamily = (typeof DETECTOR_FAMILIES)[number]

export function isDetectorFamily(value: unknown): value is DetectorFamily {
  return typeof value === 'string' && (DETECTOR_FAMILIES as readonly string[]).includes(value)
}
