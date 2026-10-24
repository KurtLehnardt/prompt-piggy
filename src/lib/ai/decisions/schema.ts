import 'server-only'
import { z } from 'zod'
import type { EngineTechnique } from '@/lib/config/techniques'

/**
 * The Decisions response shape and the result of one decide() call
 * (docs/ARCHITECTURE.md section 8.2; REVIEW-2 R2-S3; REVIEW-3 R3-01).
 *
 * The response schema accepts extra fields, so an additive API change does
 * not turn every call into a malformed answer. It is strict about the fields
 * the tripwire reads.
 */

const AnswerName = z.string().nullable().optional()

const PredicateAnswer = z.object({
  type: z.literal('predicate'),
  name: AnswerName,
  probability: z.number(),
})

const ChoiceAnswer = z.object({
  type: z.literal('choice'),
  name: AnswerName,
  choice: z.union([z.string(), z.boolean()]),
  confidence: z.number(),
})

const RefusalAnswer = z.object({
  type: z.literal('refusal'),
  name: AnswerName,
})

/** One element of `answers[]`. A score answer, or anything else, is kept as an unknown answer. */
export const DecisionsAnswerSchema = z.union([
  PredicateAnswer,
  ChoiceAnswer,
  RefusalAnswer,
  z.object({ type: z.string(), name: AnswerName }),
])

export type DecisionsAnswer = z.infer<typeof DecisionsAnswerSchema>

const TokenCount = z.int().min(0)

export const DecisionsResponseSchema = z.object({
  answers: z.array(DecisionsAnswerSchema).min(1),
  usage: z
    .object({
      input_tokens: TokenCount,
      output_tokens: TokenCount,
    })
    .optional(),
})

export type DecisionsResponse = z.infer<typeof DecisionsResponseSchema>

/** Token usage of one Decisions call, for spend settlement (src/lib/ops/spend.ts). */
export type DecisionsUsage = {
  model: string
  inputTokens: number
  outputTokens: number
}

/** Why a call counts as an outage: the guardrail fails open and the label is `unknown`. */
export type DecisionsUnavailableReason = 'timeout' | 'connection' | 'rate_limited' | 'server_error' | 'malformed'

/**
 * The result of one decide() call, as a discriminated union:
 *
 * - `ok`: the predicate's probability, within [0, 1], and the technique label.
 *   A choice outside DECISIONS_CHOICES, a confidence below 0.4, or a refused
 *   or missing choice answer is `unclassified`.
 * - `refusal`: the API declined the structural-injection question. It trips
 *   the guardrail at fail-closed levels and is never refunded.
 * - `rejected`: a 400 whose error code marks the input itself as rejected
 *   (DECISIONS_INPUT_REJECTION_CODES). The player caused it, so it trips at
 *   fail-closed levels and is never refunded.
 * - `upstream_config`: 401, 403, 404, any other non-429 4xx, or a missing
 *   API key. It is our fault, not the player's (R3-01): the attempt ends as
 *   `error` with `upstream_config`, refunded within the per-player budget,
 *   with no crack, and the call is logged at error level.
 * - `unavailable`: a timeout, a connection error, a 429, a 5xx, or a
 *   malformed answer. The guardrail does not trip, the label is `unknown`,
 *   the probability is null, and the attempt continues. It is never refunded.
 *
 * `usage` is null when no billable response arrived.
 */
export type DecideResult =
  | { kind: 'ok'; probability: number; technique: EngineTechnique; usage: DecisionsUsage | null }
  | { kind: 'refusal'; usage: DecisionsUsage | null }
  | { kind: 'rejected'; status: 400; code: string }
  | { kind: 'upstream_config'; status: number | null; code: string | null }
  | { kind: 'unavailable'; reason: DecisionsUnavailableReason; status: number | null }

export type DecideResultKind = DecideResult['kind']

/** A choice answer below this confidence is labelled `unclassified`. */
export const TECHNIQUE_MIN_CONFIDENCE = 0.4
