import 'server-only'
import type { AgentInputItem, Model } from '@openai/agents'
import {
  buildCoreAgent,
  coreRunOptions,
  coreSettingsFromEnv,
  createCoreRunner,
  type CoreSettings,
} from '@/lib/ai/core/agent'
import { createRunContext } from '@/lib/ai/core/context'
import type { DecideFn } from '@/lib/ai/core/guardrails'
import { levelPrompt, LevelNotConfiguredError } from '@/lib/ai/core/level-policies'
import {
  CoreResponsesModel,
  FailedResponseError,
  guardModel,
  IncompleteResponseError,
  type CoreCallUsage,
} from '@/lib/ai/core/model'
import { ATTEMPT_ABORT_MS } from '@/lib/ai/core/timing'
import { decide } from '@/lib/ai/decisions/client'
import type { DecisionsUsage } from '@/lib/ai/decisions/schema'
import { evaluate, type Evaluation, type RunOutcome } from '@/lib/ai/evaluator/evaluate'
import { getAiMode, getOpenAI } from '@/lib/ai/openai'
import { FakeCoreModel } from '@/lib/ai/testing/fake-model'
import { LevelConfigError, resolveLevelConfig, type ResolvedLevelConfig } from '@/lib/config/level-secrets'
import { getLevelConfig, type LevelId } from '@/lib/config/levels'
import { getEnv } from '@/lib/env'
import type { ModelUsage } from '@/lib/ops/spend'
import { canary as newCanary } from '@/lib/security/canary'
import { encapsulate, TAG_PREFIXES } from '@/lib/security/encapsulate'
import { nonce as newNonce } from '@/lib/security/nonce'

/**
 * runAttempt: one stateless Core LLM attempt, from the Decisions tripwire to
 * the Evaluator's verdict (docs/ARCHITECTURE.md sections 3, 8.2 to 8.4;
 * HARDENING_CONSTRAINTS.md constraint 3 and its orchestrator additions; HC3,
 * HC-A5; T1, T2, T3, T9, T24).
 *
 * Every call builds a new context, nonce, canary, model wrapper, Agent, and
 * Runner, and runs exactly one user message: the attacker text, JSON-encoded
 * inside `customer_message_{nonce}` tags by encapsulate() (PP-10). The input
 * type holds only the resolved level configuration and the message, so the
 * crack count, wallet, aura, user id, and every other piece of game state
 * cannot reach the model. No session, conversationId, or previousResponseId
 * is passed, and the model is never given earlier attempts.
 *
 * The level must be resolved first. A level 4 or 5 config without its
 * operator payload, or a level 1 to 3 config with one, throws
 * LevelNotConfiguredError before any Decisions or model call.
 *
 * The result carries the Evaluator's verdict and the token usage for spend
 * settlement. It never carries the canary, the nonce, or the instructions.
 * Logs carry codes only, never the message, the reply, or the canary.
 */

/** Everything runAttempt accepts: the resolved level and the attacker's message, nothing else. */
export type RunAttemptInput = {
  readonly level: ResolvedLevelConfig
  readonly message: string
}

export type AttemptRun = {
  evaluation: Evaluation
  /** Billable usage of the Decisions call and the Core calls, for src/lib/ops/spend.ts. */
  usage: ModelUsage[]
  durationMs: number
}

type LogLevel = 'warn' | 'error'
export type AttemptLogger = (level: LogLevel, entry: Record<string, string | number | boolean | null>) => void

/** Test seams. Production code calls runAttempt(), which uses the defaults. */
export type AttemptRunnerDeps = {
  /** Builds the Core model for one attempt. Default: the fake in fake mode, else the Responses API. */
  createModel?: (settings: CoreSettings) => Model
  /** Default: PP-09's decide(), which uses the Decisions fake in fake mode. */
  decide?: DecideFn
  /** Default: read from the environment on each attempt. */
  settings?: CoreSettings
  /** Default: a fresh 128-bit nonce per attempt. */
  nonce?: () => string
  /** Default: a fresh 100-bit canary per attempt. */
  canary?: () => string
  /** Default: ATTEMPT_ABORT_MS. */
  abortTimeoutMs?: number
  /** Default: one JSON line on the console. */
  log?: AttemptLogger
}

function defaultCreateModel(settings: CoreSettings): Model {
  if (getAiMode() === 'fake') return new FakeCoreModel()
  return new CoreResponsesModel(getOpenAI(), settings.model)
}

const consoleLogger: AttemptLogger = (level, entry) => {
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else console.warn(line)
}

function usageOf(error: unknown): CoreCallUsage | null {
  if (error instanceof IncompleteResponseError || error instanceof FailedResponseError) return error.usage
  return null
}

function report(log: AttemptLogger, evaluation: Evaluation, levelId: number): void {
  const entry = { event: 'core_attempt', level: levelId, outcome: evaluation.outcome, detail: evaluation.detail }
  if (evaluation.invariant) log('warn', { ...entry, event: 'core_attempt_invariant', invariant: evaluation.invariant })
  if (evaluation.detail === 'upstream_config') log('error', entry)
  else if (evaluation.outcome === 'error') log('warn', entry)
  else if (evaluation.outcome === 'fail' && evaluation.detail !== null) log('warn', entry)
}

/** Builds runAttempt with the given seams. Each returned call is independent of every other. */
export function createAttemptRunner(deps: AttemptRunnerDeps = {}) {
  return async function runAttempt(input: RunAttemptInput): Promise<AttemptRun> {
    const { level, message } = input
    if (typeof message !== 'string') throw new TypeError('runAttempt() needs the message as a string.')
    // Throws LevelNotConfiguredError before any call for an unusable level.
    levelPrompt(level)

    const started = Date.now()
    const log = deps.log ?? consoleLogger
    const nonce = (deps.nonce ?? newNonce)()
    const canary = (deps.canary ?? newCanary)()
    const context = createRunContext()
    const coreUsage: CoreCallUsage[] = []
    let decisionsUsage: DecisionsUsage | null = null
    let coreModel = deps.settings?.model ?? null

    const decideAndRecord: DecideFn = async (text, config, options) => {
      const result = await (deps.decide ?? decide)(text, config, options)
      if ((result.kind === 'ok' || result.kind === 'refusal') && result.usage) decisionsUsage = result.usage
      return result
    }

    const signal = AbortSignal.timeout(deps.abortTimeoutMs ?? ATTEMPT_ABORT_MS)
    let run: RunOutcome
    try {
      const settings = deps.settings ?? coreSettingsFromEnv(getEnv())
      coreModel = settings.model
      const model = guardModel((deps.createModel ?? defaultCreateModel)(settings), (usage) => coreUsage.push(usage))
      const agent = buildCoreAgent({ level, nonce, canary, settings, model, decide: decideAndRecord })
      const runInput: AgentInputItem[] = [
        { type: 'message', role: 'user', content: encapsulate(message, nonce, TAG_PREFIXES.customerMessage) },
      ]
      const result = await createCoreRunner().run(agent, runInput, coreRunOptions(context, signal))
      run = { kind: 'result', newItems: result.newItems }
    } catch (error) {
      const usage = usageOf(error)
      if (usage) coreUsage.push(usage)
      run = { kind: 'error', error }
    }

    const evaluation = evaluate({ run, context, canary, aborted: signal.aborted })
    report(log, evaluation, level.id)

    const usage: ModelUsage[] = []
    const decisions = decisionsUsage as DecisionsUsage | null
    if (decisions && (decisions.inputTokens > 0 || decisions.outputTokens > 0)) {
      usage.push({ api: 'decisions', ...decisions })
    }
    for (const call of coreUsage) {
      if (coreModel && (call.inputTokens > 0 || call.outputTokens > 0)) {
        usage.push({ api: 'responses', model: coreModel, ...call })
      }
    }
    return { evaluation, usage, durationMs: Date.now() - started }
  }
}

/** Runs one attempt with the production defaults. */
export function runAttempt(input: RunAttemptInput): Promise<AttemptRun> {
  return createAttemptRunner()(input)
}

export type AttemptLevelResolution =
  | { ok: true; level: ResolvedLevelConfig }
  | { ok: false; code: 'level_not_configured' | 'level_config_invalid' }

/**
 * Resolves the pinned level for an attempt (R2-12; R3-08): levels 1 to 3
 * from the repository config, levels 4 and 5 from the `level_secrets`
 * payload that start_attempt returned. A missing payload is
 * `level_not_configured` and an invalid one `level_config_invalid`; either
 * way no model call happens. Never throws and never echoes a payload value.
 */
export function resolveAttemptLevel(levelId: LevelId, payload: unknown): AttemptLevelResolution {
  try {
    const level = resolveLevelConfig(getLevelConfig(levelId), payload)
    levelPrompt(level)
    return { ok: true, level }
  } catch (error) {
    if (error instanceof LevelConfigError && error.reason === 'missing_payload') {
      return { ok: false, code: 'level_not_configured' }
    }
    if (error instanceof LevelConfigError || error instanceof LevelNotConfiguredError) {
      return { ok: false, code: 'level_config_invalid' }
    }
    throw error
  }
}
