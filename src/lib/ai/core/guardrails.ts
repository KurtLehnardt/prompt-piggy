import 'server-only'
import type { InputGuardrail, OutputGuardrail, RunContext } from '@openai/agents'
import type { DecideOptions } from '@/lib/ai/decisions/client'
import type { DecisionsConfig } from '@/lib/ai/decisions/questions'
import type { DecideResult } from '@/lib/ai/decisions/schema'
import type { AttemptRunContext } from '@/lib/ai/core/context'
import { DECISIONS_TIMEOUT_MS } from '@/lib/ai/core/timing'
import { techniqueForDecisions } from '@/lib/ai/evaluator/labels'
import type { ResolvedLevelConfig } from '@/lib/config/level-secrets'
import { TAG_PREFIXES } from '@/lib/security/encapsulate'
import { detectCanaryLeak, LEAK_FORMS, type LeakForm } from '@/lib/security/leak-detector'

/**
 * The Core agent's two guardrails (docs/ARCHITECTURE.md sections 8.2 and 8.3;
 * REVIEW-2 R2-S3; REVIEW-3 R3-01; T3).
 *
 * The Decisions tripwire is the only input guardrail. It runs with
 * `runInParallel: false`, so it finishes before the model is called, and
 * makes one Decisions call with the attacker's text as `input` only:
 *
 * | Decisions result     | Levels 1 and 2 (fail open)  | Levels 3 to 5 (fail closed) |
 * |----------------------|-----------------------------|-----------------------------|
 * | ok, p >= threshold   | trips (L2; L1 has none)     | trips: `blocked`            |
 * | ok, p < threshold    | passes                      | passes                      |
 * | refusal, rejected    | passes                      | trips: `blocked`            |
 * | unavailable          | passes, label `unknown`     | passes, label `unknown`     |
 * | upstream_config      | trips: `error`, refunded    | trips: `error`, refunded    |
 *
 * An outage (`unavailable`) fails open: the deterministic validator already
 * ran, and the canary guardrail and the Evaluator still apply. A
 * configuration fault on our side (`upstream_config`) stops the attempt
 * before any Core spend, and the Evaluator ends it as `error` with
 * `upstream_config`, refunded within the per-player budget with no crack.
 *
 * The canary guardrail is the only output guardrail. It scans the final
 * output and every message the turn produced with detectCanaryLeak() and
 * trips on any hit, even when a tool call is present. The Evaluator re-scans
 * regardless (section 8.4).
 */

/** The run input that an input guardrail receives: a string or the model items. */
type GuardrailInput = Parameters<InputGuardrail['execute']>[0]['input']
type ModelItem = Exclude<GuardrailInput, string>[number]

export type DecideFn = (text: string, config: DecisionsConfig, options: DecideOptions) => Promise<DecideResult>

export const DECISIONS_GUARDRAIL_NAME = 'decisions_structural_injection'
export const CANARY_GUARDRAIL_NAME = 'canary_leak'

/** Why the tripwire tripped, or why it let the run continue. */
export type TripwireReason =
  | 'probability'
  | 'below_threshold'
  | 'refusal'
  | 'rejected'
  | 'decisions_unavailable'
  | 'upstream_config'

/** A one-line JSON string inside nonce tags, exactly as encapsulate() writes it. */
const ENVELOPE = new RegExp(
  `^<${TAG_PREFIXES.customerMessage}_([0-9a-f]{32})>\\n([^\\n]*)\\n</${TAG_PREFIXES.customerMessage}_\\1>$`
)

function itemText(item: ModelItem): string | null {
  if (item.type !== 'message' || item.role !== 'user') return null
  if (typeof item.content === 'string') return item.content
  if (item.content.length !== 1) return null
  const [part] = item.content
  return part.type === 'input_text' ? part.text : null
}

/**
 * Recovers the attacker's original text from the run input: exactly one
 * user message holding the nonce-tag envelope. Anything else is a wiring
 * fault and throws, so the guardrail never classifies the wrong text.
 */
export function extractCustomerMessage(input: GuardrailInput): string {
  const items: ModelItem[] = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input
  if (items.length !== 1) throw new Error('The attempt input must be exactly one user message.')
  const text = itemText(items[0])
  const match = text === null ? null : ENVELOPE.exec(text)
  if (!match) throw new Error('The attempt input is not a customer_message envelope.')
  const decoded: unknown = JSON.parse(match[2])
  if (typeof decoded !== 'string') throw new Error('The customer_message envelope must hold a JSON string.')
  return decoded
}

/** The tripwire decision for one Decisions result. Pure. */
export function tripwireDecision(
  level: ResolvedLevelConfig,
  result: DecideResult
): { tripped: boolean; reason: TripwireReason } {
  switch (result.kind) {
    case 'ok': {
      const threshold = level.tripwire.threshold
      const tripped = threshold !== null && result.probability >= threshold
      return { tripped, reason: tripped ? 'probability' : 'below_threshold' }
    }
    case 'refusal':
    case 'rejected':
      return { tripped: level.tripwire.failClosed, reason: result.kind }
    case 'unavailable':
      return { tripped: false, reason: 'decisions_unavailable' }
    case 'upstream_config':
      return { tripped: true, reason: 'upstream_config' }
  }
}

/** The Decisions tripwire for one attempt. `decide` is PP-09's wrapper, or a test double. */
export function decisionsTripwire(level: ResolvedLevelConfig, decide: DecideFn): InputGuardrail {
  return {
    name: DECISIONS_GUARDRAIL_NAME,
    // The guardrail finishes before the model is called (section 8.8).
    runInParallel: false,
    execute: async ({ input, context }) => {
      const runContext = context as RunContext<AttemptRunContext>
      const result = await decide(extractCustomerMessage(input), level.decisions, { timeoutMs: DECISIONS_TIMEOUT_MS })
      runContext.context.decisionsKind = result.kind
      runContext.context.technique = techniqueForDecisions(result)
      runContext.context.tripwireProbability = result.kind === 'ok' ? result.probability : null
      const { tripped, reason } = tripwireDecision(level, result)
      return { tripwireTriggered: tripped, outputInfo: { reason } }
    },
  }
}

type OutputItem = { type?: string; role?: string; content?: unknown }

/** Every text the turn produced: the final output and each assistant message part. */
export function outputTexts(agentOutput: unknown, items: readonly unknown[] | undefined): string[] {
  const texts: string[] = []
  if (typeof agentOutput === 'string') texts.push(agentOutput)
  for (const raw of items ?? []) {
    const item = raw as OutputItem
    if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue
    for (const part of item.content as { type?: string; text?: unknown; refusal?: unknown }[]) {
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
      if (part?.type === 'refusal' && typeof part.refusal === 'string') texts.push(part.refusal)
    }
  }
  return texts
}

/** The canary output guardrail for one attempt. Its info carries form codes only, never text. */
export function canaryLeakGuardrail(canary: string): OutputGuardrail {
  return {
    name: CANARY_GUARDRAIL_NAME,
    execute: async ({ agentOutput, details }) => {
      const found = new Set<LeakForm>()
      for (const text of outputTexts(agentOutput, details?.output)) {
        for (const form of detectCanaryLeak(text, canary).forms) found.add(form)
      }
      return {
        tripwireTriggered: found.size > 0,
        outputInfo: { forms: LEAK_FORMS.filter((form) => found.has(form)) },
      }
    },
  }
}
