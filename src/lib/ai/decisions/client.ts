import 'server-only'
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai'
import type { DecisionCreateParams } from 'openai/resources/decisions'
import { getAiMode, getOpenAI } from '@/lib/ai/openai'
import { fakeDecide } from '@/lib/ai/testing/fake-decisions'
import { isEngineTechnique, type EngineTechnique } from '@/lib/config/techniques'
import { getEnv, ServerEnvError } from '@/lib/env'
import {
  ATTACK_TECHNIQUE_QUESTION,
  buildDecisionsRequest,
  STRUCTURAL_INJECTION_QUESTION,
  type DecisionsConfig,
} from './questions'
import {
  DecisionsResponseSchema,
  TECHNIQUE_MIN_CONFIDENCE,
  type DecideResult,
  type DecisionsAnswer,
  type DecisionsUnavailableReason,
} from './schema'

/**
 * The Decisions wrapper: the Validator's tripwire stage and the technique
 * label (docs/ARCHITECTURE.md section 8.2; REVIEW-2 R2-S3; REVIEW-3 R3-01).
 *
 * SDK method (section 8.8): the installed openai@7.43.0 typings include
 * `client.decisions.create(body, options)`, which POSTs to
 * https://api.openai.com/v1/decisions. This module calls it; it does not
 * need a fetch fallback. client.test.ts pins that the method exists.
 *
 * - One request asks both questions, with the attacker text only in `input`
 *   (questions.ts).
 * - The whole call, retry included, finishes inside `timeoutMs` (2.5 s from
 *   the guardrail). There is at most one retry, and only after a 5xx.
 * - Errors are classified as described on DecideResult in schema.ts. There
 *   is no fallback API: an outage fails open with `unavailable`.
 * - Logs carry the event, the status, and the error code or outage reason.
 *   They never carry the message text, the error message, or the API key.
 */

/**
 * OpenAI 400 error codes that mark the input itself as rejected, so the
 * player caused them. UNVERIFIED: the API reference documents no
 * input-rejection codes for Decisions (checked 2026-10-24), so this list holds
 * the codes OpenAI uses for flagged input elsewhere. Any other 400, such as an
 * unsupported parameter or a context-length fault in our own request, is
 * `upstream_config` (REVIEW-3 R3-01). PP-14 records the Core LLM's list from
 * the same sources.
 */
export const DECISIONS_INPUT_REJECTION_CODES: ReadonlySet<string> = new Set([
  'invalid_prompt',
  'content_policy_violation',
  'content_filter',
  'moderation_blocked',
])

/** A retry starts only when at least this much of the time budget is left. */
export const MIN_RETRY_BUDGET_MS = 250

/** Sends one request. It must stop when `signal` aborts. Tests inject their own. */
export type DecisionsTransport = (
  body: DecisionCreateParams,
  options: { signal: AbortSignal; timeoutMs: number }
) => Promise<unknown>

export type DecideOptions = {
  /** The budget for the whole call, retry included. The guardrail passes 2500. */
  timeoutMs: number
  /** Replaces the SDK call, for unit tests. When set, the fake mode is not used. */
  transport?: DecisionsTransport
  /** Overrides OPENAI_DECISIONS_MODEL. */
  model?: string
}

const sdkTransport: DecisionsTransport = (body, { signal, timeoutMs }) =>
  getOpenAI().decisions.create(body, { signal, timeout: timeoutMs, maxRetries: 0 })

class DeadlineExceeded extends Error {
  constructor() {
    super('The Decisions call ran out of time.')
    this.name = 'DeadlineExceeded'
  }
}

/**
 * Asks the Decisions API whether `text` is a structural injection and which
 * technique it uses. Never throws; every failure maps to a DecideResult.
 */
export async function decide(text: string, config: DecisionsConfig, options: DecideOptions): Promise<DecideResult> {
  if (!options.transport && getAiMode() === 'fake') return fakeDecide(text)

  let model: string
  try {
    model = options.model ?? getEnv().OPENAI_DECISIONS_MODEL
  } catch (error) {
    return classifyError(error)
  }
  const body = buildDecisionsRequest(text, config, model)
  const transport = options.transport ?? sdkTransport
  const deadline = Date.now() + Math.max(0, options.timeoutMs)

  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return unavailable('timeout', null)
    let result: DecideResult
    try {
      const raw = await callWithDeadline(transport, body, remaining)
      result = parseDecisionsResponse(raw, model)
    } catch (error) {
      result = classifyError(error)
    }
    const retryable = result.kind === 'unavailable' && result.reason === 'server_error'
    if (retryable && attempt === 0 && deadline - Date.now() >= MIN_RETRY_BUDGET_MS) continue
    report(result)
    return result
  }
}

/** Runs one request, aborting it and rejecting with DeadlineExceeded when `timeoutMs` passes. */
async function callWithDeadline(
  transport: DecisionsTransport,
  body: DecisionCreateParams,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceeded())
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([transport(body, { signal: controller.signal, timeoutMs }), expired])
  } finally {
    clearTimeout(timer)
  }
}

function unavailable(reason: DecisionsUnavailableReason, status: number | null): DecideResult {
  return { kind: 'unavailable', reason, status }
}

/** Maps a thrown error to a result. Exported for tests. */
export function classifyError(error: unknown): DecideResult {
  if (error instanceof DeadlineExceeded) return unavailable('timeout', null)
  if (error instanceof ServerEnvError) {
    // A missing or invalid setting, such as OPENAI_API_KEY: our fault (R3-01).
    return { kind: 'upstream_config', status: null, code: 'server_env' }
  }
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return unavailable('timeout', null)
  }
  if (error instanceof APIConnectionError) return unavailable('connection', null)
  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? error.status : null
    if (status === null) return unavailable('connection', null)
    if (status === 429) return unavailable('rate_limited', status)
    if (status >= 500) return unavailable('server_error', status)
    // 408 Request Timeout is a timeout, not a fault in our request.
    if (status === 408) return unavailable('timeout', status)
    const code = typeof error.code === 'string' ? error.code : null
    if (status === 400 && code !== null && DECISIONS_INPUT_REJECTION_CODES.has(code)) {
      return { kind: 'rejected', status: 400, code }
    }
    if (status >= 400) return { kind: 'upstream_config', status, code }
    return unavailable('malformed', status)
  }
  // fetch raises a TypeError for a network failure; anything else unexpected
  // also fails open, and report() logs it.
  return unavailable('connection', null)
}

/** Finds an answer by question name, or by position when the API returned no name. */
function findAnswer(answers: readonly DecisionsAnswer[], name: string, index: number): DecisionsAnswer | undefined {
  return answers.find((answer) => answer.name === name) ?? (answers[index]?.name == null ? answers[index] : undefined)
}

function techniqueFrom(answer: DecisionsAnswer | undefined): EngineTechnique {
  if (!answer || answer.type !== 'choice' || !('choice' in answer) || !('confidence' in answer)) return 'unclassified'
  const { choice, confidence } = answer
  if (typeof choice !== 'string' || !isEngineTechnique(choice)) return 'unclassified'
  if (!Number.isFinite(confidence) || confidence < TECHNIQUE_MIN_CONFIDENCE) return 'unclassified'
  return choice
}

/** Maps a response body to a result. Exported for tests. */
export function parseDecisionsResponse(raw: unknown, model: string): DecideResult {
  const parsed = DecisionsResponseSchema.safeParse(raw)
  if (!parsed.success) return unavailable('malformed', null)
  const { answers, usage: rawUsage } = parsed.data
  const usage = rawUsage ? { model, inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens } : null

  const predicate = findAnswer(answers, STRUCTURAL_INJECTION_QUESTION, 0)
  if (!predicate) return unavailable('malformed', null)
  if (predicate.type === 'refusal') return { kind: 'refusal', usage }
  if (predicate.type !== 'predicate' || !('probability' in predicate)) return unavailable('malformed', null)
  if (!Number.isFinite(predicate.probability)) return unavailable('malformed', null)
  const probability = Math.min(1, Math.max(0, predicate.probability))

  const technique = techniqueFrom(findAnswer(answers, ATTACK_TECHNIQUE_QUESTION, 1))
  return { kind: 'ok', probability, technique, usage }
}

/** Logs non-ok results without any message text, error message, or secret. */
function report(result: DecideResult): void {
  if (result.kind === 'upstream_config') {
    // Loud on purpose: a revoked key or a bad model id refunds every attempt
    // until an operator fixes it (R3-01).
    console.error(
      JSON.stringify({ event: 'decisions_upstream_config', status: result.status, code: result.code })
    )
  } else if (result.kind === 'unavailable') {
    console.warn(JSON.stringify({ event: 'decisions_unavailable', reason: result.reason, status: result.status }))
  }
}
