import { deepFreeze } from '@/lib/config/deep-freeze'
import type { LevelId } from '@/lib/config/levels'
import type { RuleSetV1 } from '@/lib/rules/schema'

/**
 * The version-0 rule set of each level (docs/ARCHITECTURE.md section 6.2,
 * column "On in version 0 for"). Every lineage starts with no keywords;
 * keywords only ever come from a verified paid win (CH-6b).
 *
 * | Flag                              | On in version 0 for |
 * |-----------------------------------|---------------------|
 * | `reject_roleplay_archetypes`      | L2 to L5            |
 * | `reject_authority_claims`         | L3 to L5            |
 * | `reject_instruction_override`     | L3 to L5            |
 * | `reject_delimiter_tokens`         | L3 to L5            |
 * | `reject_encoded_payloads`         | L4, L5              |
 * | `reject_tool_invocation_language` | L4, L5              |
 * | `reject_deferred_instructions`    | L4, L5              |
 * | `reject_mixed_script_obfuscation` | L5                  |
 * | `reject_hypothetical_framing`     | L5                  |
 *
 * Migration 00002 seeds the same payloads between its `-- seed:level:N`
 * markers, and a sync test (PP-08) compares them with this file.
 */
const SEEDS: Record<LevelId, RuleSetV1> = {
  1: {
    schema_version: 1,
    block_keywords: [],
    reject_roleplay_archetypes: false,
    reject_authority_claims: false,
    reject_instruction_override: false,
    reject_delimiter_tokens: false,
    reject_encoded_payloads: false,
    reject_tool_invocation_language: false,
    reject_deferred_instructions: false,
    reject_mixed_script_obfuscation: false,
    reject_hypothetical_framing: false,
  },
  2: {
    schema_version: 1,
    block_keywords: [],
    reject_roleplay_archetypes: true,
    reject_authority_claims: false,
    reject_instruction_override: false,
    reject_delimiter_tokens: false,
    reject_encoded_payloads: false,
    reject_tool_invocation_language: false,
    reject_deferred_instructions: false,
    reject_mixed_script_obfuscation: false,
    reject_hypothetical_framing: false,
  },
  3: {
    schema_version: 1,
    block_keywords: [],
    reject_roleplay_archetypes: true,
    reject_authority_claims: true,
    reject_instruction_override: true,
    reject_delimiter_tokens: true,
    reject_encoded_payloads: false,
    reject_tool_invocation_language: false,
    reject_deferred_instructions: false,
    reject_mixed_script_obfuscation: false,
    reject_hypothetical_framing: false,
  },
  4: {
    schema_version: 1,
    block_keywords: [],
    reject_roleplay_archetypes: true,
    reject_authority_claims: true,
    reject_instruction_override: true,
    reject_delimiter_tokens: true,
    reject_encoded_payloads: true,
    reject_tool_invocation_language: true,
    reject_deferred_instructions: true,
    reject_mixed_script_obfuscation: false,
    reject_hypothetical_framing: false,
  },
  5: {
    schema_version: 1,
    block_keywords: [],
    reject_roleplay_archetypes: true,
    reject_authority_claims: true,
    reject_instruction_override: true,
    reject_delimiter_tokens: true,
    reject_encoded_payloads: true,
    reject_tool_invocation_language: true,
    reject_deferred_instructions: true,
    reject_mixed_script_obfuscation: true,
    reject_hypothetical_framing: true,
  },
}

/** The version-0 rule sets for levels 1 to 5, deep-frozen (HC3). */
export const SEED_RULE_SETS = deepFreeze(SEEDS)
