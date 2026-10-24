import 'server-only'
import type { DecideResult } from '@/lib/ai/decisions/schema'
import type { EngineTechnique } from '@/lib/config/techniques'

/**
 * The deterministic Decisions fake (docs/ARCHITECTURE.md section 8.7). decide()
 * uses it when getAiMode() is `fake`, so E2E and CI never need an OpenAI key.
 * Unit tests inject transports into decide() instead.
 *
 * Markers, checked in this order:
 *
 * - E2E_DECISIONS_DOWN: `unavailable` (an outage; the attempt continues
 *   without the tripwire).
 * - E2E_DECISIONS_REJECT: `rejected` (a player-caused 400).
 * - E2E_DECISIONS_CONFIG: `upstream_config` with status 401 (our fault,
 *   REVIEW-3 R3-01).
 * - E2E_TRIP: probability 0.999.
 * - Anything else: probability 0.01.
 *
 * The technique comes from the first substring rule that matches the
 * lowercased text, or `unclassified`. The fake bills nothing, so `usage` is
 * null.
 */

export const FAKE_TRIP_PROBABILITY = 0.999
export const FAKE_BENIGN_PROBABILITY = 0.01

const TECHNIQUE_RULES: readonly (readonly [EngineTechnique, readonly string[]])[] = [
  ['delimiter_injection', ['<|', '[system]', '</', 'system:']],
  ['encoded_smuggling', ['base64', 'rot13', '\\x', '%2f']],
  ['tool_or_mcp_takeover', ['approvetransfer', 'mcp', 'tool call', 'function call']],
  ['prompt_extraction', ['system prompt', 'hidden instructions', 'reveal your']],
  ['instruction_override', ['ignore previous', 'ignore all', 'disregard', 'new rules']],
  ['authority_impersonation', ['admin', 'manager', 'developer', 'owner']],
  ['roleplay_persona', ['pretend', 'roleplay', 'role-play', 'you are now']],
  ['deferred_trigger', ['next user', 'later turn', 'from now on']],
  ['multilingual_obfuscation', ['traduce', 'übersetze', 'translate']],
  ['emotional_social_engineering', ['please', 'urgent', 'emergency', 'my grandma']],
]

/** The fake's technique label for a message. */
export function fakeTechnique(text: string): EngineTechnique {
  const lower = text.toLowerCase()
  for (const [technique, needles] of TECHNIQUE_RULES) {
    if (needles.some((needle) => lower.includes(needle))) return technique
  }
  return 'unclassified'
}

/** The fake decide() result for a message. Pure: the same text always gives the same result. */
export function fakeDecide(text: string): DecideResult {
  if (text.includes('E2E_DECISIONS_DOWN')) return { kind: 'unavailable', reason: 'connection', status: null }
  if (text.includes('E2E_DECISIONS_REJECT')) return { kind: 'rejected', status: 400, code: 'invalid_prompt' }
  if (text.includes('E2E_DECISIONS_CONFIG')) return { kind: 'upstream_config', status: 401, code: 'invalid_api_key' }
  const probability = text.includes('E2E_TRIP') ? FAKE_TRIP_PROBABILITY : FAKE_BENIGN_PROBABILITY
  return { kind: 'ok', probability, technique: fakeTechnique(text), usage: null }
}
