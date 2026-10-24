import 'server-only'
import { isLevelId, type LevelId } from '@/lib/config/levels'
import { getEnv } from '@/lib/env'
import { getPrice, type PricedApi } from '@/lib/ops/pricing'

/**
 * Spend sizing and cost accounting in integer micro-dollars
 * (docs/ARCHITECTURE.md sections 9.4 and 12.1; REVIEW-1 R1-09; REVIEW-2
 * R2-01; PR #6 review M2).
 *
 * The RPCs take bigint micro-dollar parameters, so every value here is a
 * whole number. Reservations are upper bounds; settlement uses the actual
 * usage, rounded up to whole micros.
 */

/** Token usage of one model call. Output tokens include reasoning tokens. */
export type ModelUsage = {
  api: PricedApi
  model: string
  inputTokens: number
  outputTokens: number
}

/** The worst case of section 9.4, at the default MAX_PROMPT_CHARS. */
export const WORST_CASE_PROMPT_CHARS = 2000
/** One Decisions call reads about 1,300 input tokens at most (section 9.4). */
export const DECISIONS_MAX_INPUT_TOKENS = 1300
/** Each Core turn reads about 2,000 input tokens at most (section 9.4). */
export const CORE_TURN_MAX_INPUT_TOKENS = 2000
/** An attempt runs at most two Core turns (`maxTurns` 2, section 8.3). */
export const CORE_MAX_TURNS = 2
/** One Hardening Engine call: the developer prompt plus the breach envelope (section 8.5). */
export const HARDENING_MAX_INPUT_TOKENS = 3000

const MICROS_PER_USD = 1_000_000
const TOKENS_PER_PRICE_UNIT = 1_000_000

function assertTokenCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Token counts must be whole, non-negative numbers.')
  }
}

/**
 * The cost of the given calls in micro-dollars, rounded up to a whole micro.
 * Throws PriceNotConfiguredError for a model without a price (fail closed).
 */
export function costMicrosFromUsage(usages: readonly ModelUsage[]): number {
  // Integer arithmetic: tokens times micros per 1M tokens, divided by 1M once.
  let numerator = 0
  for (const usage of usages) {
    assertTokenCount(usage.inputTokens)
    assertTokenCount(usage.outputTokens)
    const price = getPrice(usage.api, usage.model)
    numerator += usage.inputTokens * price.inputMicrosPer1M + usage.outputTokens * price.outputMicrosPer1M
  }
  if (!Number.isSafeInteger(numerator)) throw new RangeError('The usage is too large to price exactly.')
  const remainder = numerator % TOKENS_PER_PRICE_UNIT
  return (numerator - remainder) / TOKENS_PER_PRICE_UNIT + (remainder > 0 ? 1 : 0)
}

/**
 * Converts US dollars to integer micro-dollars with Math.round, so a value
 * such as 2.01, whose float product is 2009999.9999999998, becomes 2010000
 * before it reaches a bigint RPC parameter (PR #6 review M2).
 */
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError('A dollar amount must be finite and non-negative.')
  return Math.round(usd * MICROS_PER_USD)
}

/** Scales a section 9.4 token bound when MAX_PROMPT_CHARS is above its default. */
function scaledTokens(tokens: number, maxPromptChars: number): number {
  return Math.ceil((tokens * Math.max(WORST_CASE_PROMPT_CHARS, maxPromptChars)) / WORST_CASE_PROMPT_CHARS)
}

/**
 * The worst-case usage of one attempt: one Decisions call plus two Core
 * turns, each at OPENAI_CORE_MAX_OUTPUT_TOKENS output tokens, reasoning
 * included. Input bounds scale up with MAX_PROMPT_CHARS above 2,000.
 */
export function attemptWorstCaseUsage(): ModelUsage[] {
  const env = getEnv()
  const usages: ModelUsage[] = [
    {
      api: 'decisions',
      model: env.OPENAI_DECISIONS_MODEL,
      inputTokens: scaledTokens(DECISIONS_MAX_INPUT_TOKENS, env.MAX_PROMPT_CHARS),
      outputTokens: 0,
    },
  ]
  for (let turn = 0; turn < CORE_MAX_TURNS; turn += 1) {
    usages.push({
      api: 'responses',
      model: env.OPENAI_CORE_MODEL,
      inputTokens: scaledTokens(CORE_TURN_MAX_INPUT_TOKENS, env.MAX_PROMPT_CHARS),
      outputTokens: env.OPENAI_CORE_MAX_OUTPUT_TOKENS,
    })
  }
  return usages
}

/**
 * The per-attempt reservation `c_max` for `start_attempt` (section 9.4).
 * Every level runs the same pipeline (one Decisions call, at most two Core
 * turns), so the reserve is the same at every level today; the level is
 * validated so a bad id fails before any reservation.
 */
export function estimateAttemptReserveMicros(level: LevelId): number {
  if (!isLevelId(level)) throw new RangeError('Unknown level id.')
  return costMicrosFromUsage(attemptWorstCaseUsage())
}

/**
 * The reservation for one hardening job: exactly one Hardening Engine call at
 * OPENAI_HARDENING_MAX_OUTPUT_TOKENS, with no stage B (REVIEW-1 R1-S1).
 */
export function estimateHardeningReserveMicros(): number {
  const env = getEnv()
  return costMicrosFromUsage([
    {
      api: 'responses',
      model: env.OPENAI_HARDENING_MODEL,
      inputTokens: scaledTokens(HARDENING_MAX_INPUT_TOKENS, env.MAX_PROMPT_CHARS),
      outputTokens: env.OPENAI_HARDENING_MAX_OUTPUT_TOKENS,
    },
  ])
}
