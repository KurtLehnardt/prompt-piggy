import { deepFreeze } from '@/lib/config/deep-freeze'

/**
 * Attack-technique labels (docs/ARCHITECTURE.md sections 5.2 and 8.2, R2-S3).
 *
 * Labels are display data only. They never decide an outcome and never feed
 * hardening (CH-6b).
 *
 * - ENGINE_TECHNIQUES: the 11 classes. They are the Decisions choices and the
 *   only labels the Hardening Engine may propose.
 * - ATTACK_TECHNIQUES: the 11 classes plus `unknown`, in the order of the SQL
 *   enum `public.attack_technique`. `unknown` means the Decisions call was
 *   unavailable, so it is never a model choice or an engine label.
 */
export const ENGINE_TECHNIQUES = deepFreeze([
  'roleplay_persona',
  'authority_impersonation',
  'instruction_override',
  'delimiter_injection',
  'encoded_smuggling',
  'tool_or_mcp_takeover',
  'deferred_trigger',
  'emotional_social_engineering',
  'prompt_extraction',
  'multilingual_obfuscation',
  'unclassified',
] as const)

export type EngineTechnique = (typeof ENGINE_TECHNIQUES)[number]

export const ATTACK_TECHNIQUES = deepFreeze([...ENGINE_TECHNIQUES, 'unknown'] as const)

export type AttackTechnique = (typeof ATTACK_TECHNIQUES)[number]

/**
 * The choice descriptions sent to the Decisions API, verbatim from section
 * 8.2. They are fixed strings: no player or engine text ever reaches them.
 */
export const TECHNIQUE_DESCRIPTIONS = deepFreeze({
  roleplay_persona: 'Asks the assistant to become a character or mode.',
  authority_impersonation: 'Claims to be staff, an admin, a developer, or an owner.',
  instruction_override: 'Tells the assistant to ignore or replace its rules.',
  delimiter_injection: 'Uses fake message markup or prompt delimiters.',
  encoded_smuggling: 'Hides instructions in encodings or ciphers.',
  tool_or_mcp_takeover: 'Talks about tools, functions, MCP, or calling approveTransfer.',
  deferred_trigger: 'Plants instructions for later turns or future users.',
  emotional_social_engineering: 'Uses urgency, sympathy, flattery, or guilt.',
  prompt_extraction: 'Tries to reveal hidden instructions or secrets.',
  multilingual_obfuscation: 'Mixes languages, scripts, or look-alike characters.',
  unclassified: 'None of the above, or not an attack.',
} as const satisfies Record<EngineTechnique, string>)

/** The `choices` array of the Decisions `attack_technique` question (section 8.2). */
export const DECISIONS_CHOICES = deepFreeze(
  ENGINE_TECHNIQUES.map((value) => ({ value, description: TECHNIQUE_DESCRIPTIONS[value] }))
)

export type DecisionsChoice = (typeof DECISIONS_CHOICES)[number]

/** Short display labels for badges on the game page and /live. */
export const TECHNIQUE_LABELS = deepFreeze({
  roleplay_persona: 'Role-play persona',
  authority_impersonation: 'Authority impersonation',
  instruction_override: 'Instruction override',
  delimiter_injection: 'Delimiter injection',
  encoded_smuggling: 'Encoded smuggling',
  tool_or_mcp_takeover: 'Tool or MCP takeover',
  deferred_trigger: 'Deferred trigger',
  emotional_social_engineering: 'Social engineering',
  prompt_extraction: 'Prompt extraction',
  multilingual_obfuscation: 'Multilingual obfuscation',
  unclassified: 'Unclassified',
  unknown: 'Unknown',
} as const satisfies Record<AttackTechnique, string>)

export function isAttackTechnique(value: unknown): value is AttackTechnique {
  return typeof value === 'string' && (ATTACK_TECHNIQUES as readonly string[]).includes(value)
}

export function isEngineTechnique(value: unknown): value is EngineTechnique {
  return typeof value === 'string' && (ENGINE_TECHNIQUES as readonly string[]).includes(value)
}
