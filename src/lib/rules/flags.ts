import { deepFreeze } from '@/lib/config/deep-freeze'
import type { DetectorFamily } from '@/lib/config/detector-families'

/**
 * The nine detector flags of a rule set (docs/ARCHITECTURE.md sections 6.1 and
 * 6.2), in catalog order.
 *
 * Each flag only switches a code-defined detector family of the Dynamic
 * Validator from "signal" to "block" (HC1). A flag carries no prompt fragment
 * and no text of any kind: the Core LLM's instructions depend on the level
 * alone, never on a rule set (REVIEW-1 R1-S1). Extending the catalog means
 * adding a flag here, a family in src/lib/config/detector-families.ts, and the
 * detector code behind it, never a free-text field.
 */
export const FLAG_NAMES = deepFreeze([
  'reject_roleplay_archetypes',
  'reject_authority_claims',
  'reject_instruction_override',
  'reject_delimiter_tokens',
  'reject_encoded_payloads',
  'reject_tool_invocation_language',
  'reject_deferred_instructions',
  'reject_mixed_script_obfuscation',
  'reject_hypothetical_framing',
] as const)

export type FlagName = (typeof FLAG_NAMES)[number]

/** The detector family that each flag switches on, exactly as in section 6.2. */
export const FLAG_DETECTOR_FAMILIES = deepFreeze({
  reject_roleplay_archetypes: 'roleplay',
  reject_authority_claims: 'authority',
  reject_instruction_override: 'override',
  reject_delimiter_tokens: 'delimiter',
  reject_encoded_payloads: 'decode',
  reject_tool_invocation_language: 'tool',
  reject_deferred_instructions: 'deferred',
  reject_mixed_script_obfuscation: 'mixed_script',
  reject_hypothetical_framing: 'hypothetical',
} as const satisfies Record<FlagName, DetectorFamily>)

/** The inverse of FLAG_DETECTOR_FAMILIES: the flag that switches each family on. */
export const DETECTOR_FAMILY_FLAGS = deepFreeze({
  roleplay: 'reject_roleplay_archetypes',
  authority: 'reject_authority_claims',
  override: 'reject_instruction_override',
  delimiter: 'reject_delimiter_tokens',
  decode: 'reject_encoded_payloads',
  tool: 'reject_tool_invocation_language',
  deferred: 'reject_deferred_instructions',
  mixed_script: 'reject_mixed_script_obfuscation',
  hypothetical: 'reject_hypothetical_framing',
} as const satisfies Record<DetectorFamily, FlagName>)

export function isFlagName(value: unknown): value is FlagName {
  return typeof value === 'string' && (FLAG_NAMES as readonly string[]).includes(value)
}

/** The detector family that a flag switches on. */
export function familyOfFlag(flag: FlagName): DetectorFamily {
  return FLAG_DETECTOR_FAMILIES[flag]
}

/** The flag that switches a detector family on. */
export function flagOfFamily(family: DetectorFamily): FlagName {
  return DETECTOR_FAMILY_FLAGS[family]
}
