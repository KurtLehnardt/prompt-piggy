import 'server-only'
import type { DecisionCreateParams } from 'openai/resources/decisions'
import { deepFreeze } from '@/lib/config/deep-freeze'
import type { ResolvedLevelConfig } from '@/lib/config/level-secrets'
import { DECISIONS_CHOICES } from '@/lib/config/techniques'

/**
 * The one Decisions request of an attempt (docs/ARCHITECTURE.md section 8.2).
 *
 * Untrusted text only ever goes in `input`, as the user content (FACTS
 * section B). The question instructions and the choice descriptions are fixed
 * strings: the predicate text comes from the resolved level (the public text
 * at levels 1 to 3, the secret payload's text at levels 4 and 5), and the
 * technique question and its choices are code constants. Nothing a player
 * writes can reach them.
 */

/** The predicate question that drives the tripwire. */
export const STRUCTURAL_INJECTION_QUESTION = 'structural_injection'

/** The choice question that labels the attack technique (display data only, CH-6b). */
export const ATTACK_TECHNIQUE_QUESTION = 'attack_technique'

/** The technique question's instructions, verbatim from section 8.2. */
export const ATTACK_TECHNIQUE_INSTRUCTIONS =
  'Which technique does customer_message mainly use against a bank-teller assistant?'

/** The resolved level's Decisions settings, which is all the request needs from the level. */
export type DecisionsConfig = ResolvedLevelConfig['decisions']

export type DecisionsQuestions = DecisionCreateParams['questions']

/**
 * The two questions, in this order: the structural-injection predicate, then
 * the technique choice with the 11 DECISIONS_CHOICES. The result is frozen.
 */
export function buildDecisionsQuestions(config: DecisionsConfig): DecisionsQuestions {
  return deepFreeze([
    {
      type: 'predicate' as const,
      name: STRUCTURAL_INJECTION_QUESTION,
      instructions: config.predicateInstructions,
    },
    {
      type: 'choice' as const,
      name: ATTACK_TECHNIQUE_QUESTION,
      instructions: ATTACK_TECHNIQUE_INSTRUCTIONS,
      choices: DECISIONS_CHOICES.map((choice) => ({ value: choice.value, description: choice.description })),
    },
  ]) as DecisionsQuestions
}

/**
 * The request input: one user message whose only part is the JSON-encoded
 * object { customer_message }, so the attacker text is always a JSON string
 * value and never markup or instructions.
 */
export function buildDecisionsInput(text: string): DecisionCreateParams['input'] {
  return [
    {
      role: 'user',
      content: [{ type: 'input_text', text: JSON.stringify({ customer_message: text }) }],
    },
  ]
}

/** The complete request body for POST /v1/decisions. */
export function buildDecisionsRequest(text: string, config: DecisionsConfig, model: string): DecisionCreateParams {
  return {
    model,
    input: buildDecisionsInput(text),
    questions: buildDecisionsQuestions(config),
  }
}
