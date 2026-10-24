import 'server-only'
import { createHash } from 'node:crypto'
import { resolveAttemptLevel, runAttempt as defaultRunAttempt, type AttemptRun, type RunAttemptInput } from '@/lib/ai/core/run-attempt'
import type { Evaluation } from '@/lib/ai/evaluator/evaluate'
import { techniqueForReasons } from '@/lib/ai/evaluator/labels'
import { FIXED_REPLIES, fixedReply } from '@/lib/ai/evaluator/reply'
import { deepFreeze } from '@/lib/config/deep-freeze'
import type { ResolvedLevelConfig } from '@/lib/config/level-secrets'
import { LEVEL_IDS, type LevelId } from '@/lib/config/levels'
import type { AttackTechnique } from '@/lib/config/techniques'
import { mapRpcError, type RpcErrorMapping } from '@/lib/errors'
import { isKilledByEnv } from '@/lib/ops/kill-switch'
import { ATTEMPT_STALE_SECONDS, getLimits, type Limits } from '@/lib/ops/limits'
import { costMicrosFromUsage, estimateAttemptReserveMicros } from '@/lib/ops/spend'
import { RuleSetSchema } from '@/lib/rules/schema'
import benignCorpus from '@/lib/validator/__fixtures__/benign.v1.json'
import {
  createAttemptRpc,
  isUnstorable,
  type AttemptRpc,
  type AttemptSettlement,
  type RecordAttemptInput,
  type RecordResult,
  type StartedAttempt,
  type StoredAttempt,
} from '@/lib/game/rpc'
import { fingerprint as defaultFingerprint, validate as defaultValidate, type ValidatorResult } from '@/lib/validator'
import {
  ATTEMPT_FAIL_DETAILS,
  AttemptResultDTOSchema,
  type AttemptErrorCode,
  type AttemptOutcome,
  type AttemptResultDTO,
} from '@/types/api'

/**
 * The attempt service: one POST /api/attempts from start to settlement
 * (docs/ARCHITECTURE.md sections 3, 7, 8.1 to 8.4, 9.4, and 9.6;
 * HARDENING_CONSTRAINTS.md constraint 3 and its orchestrator additions; HC3,
 * HC-A4, HC-A5, CH-1, CH-6b; REVIEW-2 R2-01, R2-05, R2-12, R2-14; REVIEW-3
 * R3-06, R3-07, R3-08; T9, T13, T16, T25).
 *
 * The route has already verified the user with getUser(), checked the
 * Origin, parsed the body, and honoured the environment kill switch. Then:
 *
 * 1. fingerprint(message) and the message's SHA-256.
 * 2. start_attempt: the database kill switch, the rate limits, the $1 debit
 *    into the treasury, and the pinned level, epoch, rule set, and (at
 *    levels 4 and 5) level secret. The price is taken here, before any model
 *    call (CH-1). A refusal (pig_changed, insufficient_funds,
 *    level_not_configured, a rate limit, the kill switch, the spend cap)
 *    charges nothing and becomes the matching error response.
 * 3. A repeated idempotency key for a finalized attempt returns the stored
 *    DTO from attempt_result, with no model call (R2-05, R2-S3). A same-key
 *    attempt that is still pending is a 409 attempt_in_flight; when it is
 *    about to go stale, the service runs the budgeted reaper and asks once
 *    more, so a stranded attempt settles as `reaped` instead of locking the
 *    key (R3-06).
 * 4. resolveAttemptLevel() with the pinned level and the payload that
 *    start_attempt returned. The service never reads the secret table
 *    itself. A payload that does not resolve settles as error
 *    `level_config_invalid` (R2-12, R3-08).
 * 5. A fingerprint on the replay blocklist settles as `blocked` with reason
 *    `replayed_breach`, and the validator and every OpenAI call are skipped.
 * 6. validate(message, rules, level) runs before any OpenAI call (HC-A4). A
 *    block settles as `blocked` with no OpenAI call.
 * 7. runAttempt({ level, message }): the stateless Core LLM run and the
 *    Evaluator's verdict (PP-14).
 * 8. record_attempt with the verdict. A paid win asks it to block the
 *    prompt's fingerprint, unless the fingerprint belongs to a benign fixture
 *    prompt (CH-6b). A reply that cannot be stored settles as error
 *    `reply_unstorable` under the refund budget (R3-07).
 * 9. The DTO comes from record_attempt's (or attempt_result's) return values
 *    only: no money, crack, aura, or level arithmetic happens here (HC-A5).
 * 10. After the response: the hardening hook for a paid win, and the
 *    lease-guarded sweep for every attempt.
 *
 * Statelessness (HC3): the pipeline sees the message, the pinned rule set,
 * and the resolved level, and nothing else. The start result carries no
 * wallet or player state, and this module never reads the player's crack
 * count, balance, or aura. Logs carry event codes, SQLSTATEs, and counts
 * only: never the message, the reply, a canary, a nonce, or a level secret
 * (T25).
 */

// ---------------------------------------------------------------------------
// The hardening seam

/** A verified paid win: the one event that may start the gated hardening pipeline (HC-A5). */
export type PaidWin = {
  readonly attemptId: string
  /** The level that was beaten. */
  readonly levelId: LevelId
  /** The job record_attempt created, or null when none was created or the result was read back. */
  readonly hardeningJobId: string | null
}

/** Work that runs after the response is sent, through after() in the route. */
export type AttemptAfterHooks = {
  /** Runs once for a paid win (outcome win, never late_win or anything else). */
  onPaidWin(win: PaidWin): Promise<void>
  /** Runs once for every attempt that reached start_attempt. */
  maybeSweep(): Promise<void>
}

/**
 * The hardening kick for a paid win. The hardening pipeline is not part of
 * this build, so this does nothing: record_attempt has already written the
 * breach fingerprint and the queued hardening job, and the job waits in the
 * queue for the pipeline to claim it. The pipeline supplies its own kick
 * through AttemptAfterHooks.onPaidWin.
 */
export const kickHardening: (win: PaidWin) => Promise<void> = async () => {}

/** The sweep's lease: at most one sweep per lease period across all instances. */
export const SWEEP_LEASE_KEY = 'sweep'
export const SWEEP_LEASE_SECONDS = 60
export const SWEEP_REAP_LIMIT = 50

/**
 * The default sweep: once per lease period, finalize attempts stranded by a
 * killed function as error `reaped` through the budgeted error path. It
 * never touches hardening jobs. It does nothing while PIGGY_KILL_SWITCH is
 * set.
 */
export async function sweepStaleAttempts(rpc: AttemptRpc): Promise<void> {
  if (isKilledByEnv()) return
  if (!(await rpc.claimLease(SWEEP_LEASE_KEY, SWEEP_LEASE_SECONDS))) return
  await rpc.reapStaleAttempts(ATTEMPT_STALE_SECONDS, SWEEP_REAP_LIMIT)
}

export function defaultAfterHooks(rpc: AttemptRpc): AttemptAfterHooks {
  return { onPaidWin: kickHardening, maybeSweep: () => sweepStaleAttempts(rpc) }
}

// ---------------------------------------------------------------------------
// Benign fixture fingerprints (CH-6b, section 9.6)

type BenignCase = { text: string }

/**
 * Fingerprints of every benign fixture prompt. A paid win whose fingerprint
 * is here is paid but never added to the replay blocklist, so a lucky benign
 * prompt can never block benign traffic; the attempt is logged instead.
 */
export const BENIGN_FIXTURE_FINGERPRINTS: readonly string[] = deepFreeze(
  (benignCorpus.cases as readonly BenignCase[]).map((entry) => defaultFingerprint(entry.text))
)

// ---------------------------------------------------------------------------
// Service types

export type AttemptCommand = {
  /** The id from getUser(), never from the request body. */
  userId: string
  message: string
  idempotencyKey: string
  expectedEpoch: number
}

export type ServiceLogger = (level: 'warn' | 'error', entry: Record<string, string | number | boolean | null>) => void

/** Test seams. The route passes none, so production uses the defaults. */
export type AttemptServiceDeps = {
  rpc?: AttemptRpc
  runAttempt?: (input: RunAttemptInput) => Promise<AttemptRun>
  validate?: typeof defaultValidate
  fingerprint?: typeof defaultFingerprint
  hooks?: AttemptAfterHooks
  limits?: Limits
  reserveMicros?: () => number
  log?: ServiceLogger
}

export type AttemptServiceResult =
  | { kind: 'ok'; attempt: AttemptResultDTO; afterResponse: () => Promise<void> }
  | { kind: 'error'; mapping: RpcErrorMapping; afterResponse: () => Promise<void> }

const consoleLogger: ServiceLogger = (level, entry) => {
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else console.warn(line)
}

/** How many stale attempts one same-key recovery may reap (R3-06). */
export const SAME_KEY_REAP_LIMIT = 50

const FAIL_DETAILS: ReadonlySet<string> = new Set(ATTEMPT_FAIL_DETAILS)

/**
 * The reservation for one attempt. Every level runs the same pipeline, and
 * the level is pinned only inside start_attempt, so the service reserves the
 * largest per-level bound.
 */
export function attemptReserveMicros(): number {
  return Math.max(...LEVEL_IDS.map((id) => estimateAttemptReserveMicros(id)))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

// ---------------------------------------------------------------------------
// The verdict for record_attempt

/** Everything record_attempt needs besides the attempt id, plus the display copy. */
type Verdict = Omit<RecordAttemptInput, 'attemptId' | 'blockFingerprint' | 'userJobsPerHour'> & {
  /** The reply shown for a fail: the Evaluator's sanitized text. */
  failReply: string
}

function errorVerdict(code: AttemptErrorCode, costMicros: number, validator: ValidatorResult | null): Verdict {
  return {
    outcome: 'error',
    reply: null,
    validatorReasons: validator?.reasons ?? [],
    validatorSignals: validator?.signals ?? [],
    tripwireProbability: null,
    technique: 'unclassified',
    canaryLeaked: false,
    toolCalled: false,
    costMicros,
    errorCode: code,
    failReply: FIXED_REPLIES.fail_without_text,
  }
}

function blockedVerdict(reasons: readonly string[], signals: readonly string[], technique: AttackTechnique): Verdict {
  return {
    outcome: 'blocked',
    reply: null,
    validatorReasons: reasons,
    validatorSignals: signals,
    tripwireProbability: null,
    technique,
    canaryLeaked: false,
    toolCalled: false,
    costMicros: 0,
    errorCode: null,
    failReply: FIXED_REPLIES.fail_without_text,
  }
}

function evaluationVerdict(evaluation: Evaluation, validator: ValidatorResult, costMicros: number): Verdict {
  const { outcome, detail } = evaluation
  let errorCode: string | null = null
  if (outcome === 'error') errorCode = detail ?? 'upstream_error'
  else if (outcome === 'fail' && detail !== null && FAIL_DETAILS.has(detail)) errorCode = detail
  return {
    outcome,
    reply: outcome === 'fail' ? evaluation.reply : null,
    validatorReasons: validator.reasons,
    validatorSignals: validator.signals,
    tripwireProbability: evaluation.tripwireProbability,
    technique: evaluation.technique,
    canaryLeaked: evaluation.canaryLeaked,
    toolCalled: evaluation.toolCalled,
    costMicros,
    errorCode,
    failReply: evaluation.reply,
  }
}

// ---------------------------------------------------------------------------
// DTOs: copied from the database's return values, never computed

function displayReply(outcome: AttemptOutcome, failReply: string | null): string {
  if (outcome === 'fail') return failReply ?? FIXED_REPLIES.fail_without_text
  return fixedReply(outcome)
}

function dtoFromSettlement(
  started: StartedAttempt,
  settlement: AttemptSettlement,
  verdict: Verdict
): AttemptResultDTO {
  return AttemptResultDTOSchema.parse({
    id: started.attemptId,
    level: started.levelId,
    outcome: settlement.outcome,
    reply: displayReply(settlement.outcome, verdict.failReply),
    technique: verdict.technique,
    cracks: settlement.cracksAfter,
    crackEvent: settlement.crackEvent,
    priceCents: started.priceCents,
    payoutCents: settlement.payoutCents,
    refundCents: settlement.refundCents,
    refundWithheld: settlement.refundWithheld,
    walletBalanceCents: settlement.walletBalanceCents,
    auraBps: settlement.auraBps,
    game: { treasuryCents: settlement.treasuryCents, level: settlement.currentLevel, pigEpoch: settlement.pigEpoch },
    levelAdvanced:
      settlement.levelTo !== null ? { from: settlement.levelFrom ?? started.levelId, to: settlement.levelTo } : null,
  }) as AttemptResultDTO
}

function dtoFromStored(attemptId: string, priceCents: number, stored: StoredAttempt): AttemptResultDTO {
  return AttemptResultDTOSchema.parse({
    id: attemptId,
    level: stored.levelId,
    outcome: stored.outcome,
    reply: displayReply(stored.outcome, stored.reply),
    technique: stored.technique ?? 'unclassified',
    cracks: stored.cracksAfter,
    crackEvent: stored.crackEvent,
    priceCents,
    payoutCents: stored.payoutCents,
    refundCents: stored.refundCents,
    refundWithheld: stored.refundWithheld,
    walletBalanceCents: stored.walletBalanceCents,
    auraBps: stored.auraBps,
    game: { treasuryCents: stored.treasuryCents, level: stored.currentLevel, pigEpoch: stored.pigEpoch },
    levelAdvanced: stored.levelTo !== null ? { from: stored.levelId, to: stored.levelTo } : null,
  }) as AttemptResultDTO
}

// ---------------------------------------------------------------------------
// The service

/** Runs one attempt for an authenticated user. Never throws. */
export async function performAttempt(
  command: AttemptCommand,
  deps: AttemptServiceDeps = {}
): Promise<AttemptServiceResult> {
  const log = deps.log ?? consoleLogger
  const noAfter = async () => {}

  let limits: Limits
  let reserveMicros: number
  let rpc: AttemptRpc
  try {
    limits = deps.limits ?? getLimits()
    reserveMicros = (deps.reserveMicros ?? attemptReserveMicros)()
    rpc = deps.rpc ?? createAttemptRpc()
  } catch (error) {
    return failure(error, log, 'attempt_setup', noAfter)
  }

  const hooks = deps.hooks ?? defaultAfterHooks(rpc)
  let paidWin: PaidWin | null = null
  const afterResponse = async () => {
    if (paidWin) await runHook(log, 'on_paid_win', () => hooks.onPaidWin(paidWin as PaidWin))
    await runHook(log, 'sweep', () => hooks.maybeSweep())
  }

  const fingerprintOf = deps.fingerprint ?? defaultFingerprint
  let promptFingerprint: string
  try {
    promptFingerprint = fingerprintOf(command.message)
  } catch (error) {
    return failure(error, log, 'attempt_fingerprint', noAfter)
  }

  const startInput = {
    userId: command.userId,
    idempotencyKey: command.idempotencyKey,
    expectedEpoch: command.expectedEpoch,
    prompt: command.message,
    promptSha256: sha256Hex(command.message),
    promptFingerprint,
    reserveMicros,
    dailyCapMicros: limits.dailyCapMicros,
    attemptShareBps: limits.attemptShareBps,
    rateCapacity: limits.burst,
    rateRefillPerMin: limits.perMin,
    dailyAttemptCap: limits.perDay,
    staleSeconds: ATTEMPT_STALE_SECONDS,
  }

  let started: StartedAttempt
  try {
    started = await startWithRecovery(rpc, startInput, log)
  } catch (error) {
    return failure(error, log, 'attempt_start', afterResponse)
  }

  // A finalized attempt with this key: its stored result, with no model call (R2-05).
  if (started.replay) {
    try {
      const stored = await rpc.attemptResult(command.userId, started.attemptId)
      if (!stored) throw new Error('attempt_result returned no row for a replay.')
      return { kind: 'ok', attempt: dtoFromStored(started.attemptId, started.priceCents, stored), afterResponse }
    } catch (error) {
      return failure(error, log, 'attempt_replay', afterResponse)
    }
  }

  // The fee is taken. Every path below ends in record_attempt.
  const verdict = await decide(command.message, started, { reserveMicros, maxChars: limits.maxPromptChars }, deps, log)
  const blockFingerprint = verdict.outcome === 'win' && !BENIGN_FIXTURE_FINGERPRINTS.includes(promptFingerprint)
  if (verdict.outcome === 'win' && !blockFingerprint) log('warn', { event: 'attempt_benign_win', level: started.levelId })

  const recordInput: RecordAttemptInput = {
    attemptId: started.attemptId,
    outcome: verdict.outcome,
    reply: verdict.reply,
    validatorReasons: verdict.validatorReasons,
    validatorSignals: verdict.validatorSignals,
    tripwireProbability: verdict.tripwireProbability,
    technique: verdict.technique,
    canaryLeaked: verdict.canaryLeaked,
    toolCalled: verdict.toolCalled,
    costMicros: verdict.costMicros,
    errorCode: verdict.errorCode,
    blockFingerprint,
    userJobsPerHour: limits.jobsPerUserPerHour,
  }

  let recorded: RecordResult
  try {
    recorded = await settle(rpc, command.userId, recordInput, log)
  } catch (error) {
    return failure(error, log, 'attempt_record', afterResponse)
  }

  try {
    if (recorded.source === 'recorded') {
      const { settlement } = recorded
      if (settlement.outcome === 'win') {
        paidWin = { attemptId: started.attemptId, levelId: started.levelId, hardeningJobId: settlement.hardeningJobId }
      }
      return { kind: 'ok', attempt: dtoFromSettlement(started, settlement, verdict), afterResponse }
    }
    const { stored } = recorded
    if (stored.outcome === 'win') {
      paidWin = { attemptId: started.attemptId, levelId: started.levelId, hardeningJobId: null }
    }
    return { kind: 'ok', attempt: dtoFromStored(started.attemptId, started.priceCents, stored), afterResponse }
  } catch (error) {
    return failure(error, log, 'attempt_result_shape', afterResponse)
  }
}

function failure(
  error: unknown,
  log: ServiceLogger,
  event: string,
  afterResponse: () => Promise<void>
): AttemptServiceResult {
  const mapping = mapRpcError(error, { action: 'attack' })
  if (mapping.log) {
    log('error', { event, error: errorName(error), ...mapping.logContext })
  }
  return { kind: 'error', mapping, afterResponse }
}

async function runHook(log: ServiceLogger, hook: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    log('warn', { event: 'attempt_after_hook_failed', hook, error: errorName(error) })
  }
}

/**
 * start_attempt, plus the same-key recovery of R3-06: when this key's own
 * attempt is pending and at most a second from stale, reap stale attempts
 * through the budgeted error path and ask once more, which then replays the
 * reaped attempt. Otherwise the original error stands.
 */
async function startWithRecovery(
  rpc: AttemptRpc,
  input: Parameters<AttemptRpc['startAttempt']>[0],
  log: ServiceLogger
): Promise<StartedAttempt> {
  try {
    return await rpc.startAttempt(input)
  } catch (error) {
    const { body } = mapRpcError(error)
    if (body.code !== 'attempt_in_flight' || !body.sameKey || body.retryAfterSeconds > 1) throw error
    let reaped = 0
    try {
      reaped = await rpc.reapStaleAttempts(ATTEMPT_STALE_SECONDS, SAME_KEY_REAP_LIMIT)
    } catch (reapError) {
      log('warn', { event: 'attempt_same_key_reap_failed', error: errorName(reapError) })
      throw error
    }
    if (reaped === 0) throw error
    log('warn', { event: 'attempt_same_key_reaped', reaped })
    return await rpc.startAttempt(input)
  }
}

/** The pipeline after the fee: level, fingerprint block, validator, Core LLM, Evaluator. Never throws. */
async function decide(
  message: string,
  started: StartedAttempt,
  budget: { reserveMicros: number; maxChars: number },
  deps: AttemptServiceDeps,
  log: ServiceLogger
): Promise<Verdict> {
  let validator: ValidatorResult | null = null
  let modelReached = false
  try {
    const resolution = resolveAttemptLevel(started.levelId, started.levelSecret)
    if (!resolution.ok) {
      log('error', { event: 'attempt_level_unresolved', level: started.levelId, code: resolution.code })
      return errorVerdict('level_config_invalid', 0, null)
    }
    const level: ResolvedLevelConfig = resolution.level

    const rules = RuleSetSchema.safeParse(started.rules)
    if (!rules.success) {
      log('error', { event: 'attempt_rules_invalid', level: started.levelId })
      return errorVerdict('level_config_invalid', 0, null)
    }

    if (started.fingerprintBlocked) {
      return blockedVerdict(['replayed_breach'], [], techniqueForReasons(['replayed_breach']))
    }

    validator = (deps.validate ?? defaultValidate)(message, rules.data, level, { maxChars: budget.maxChars })
    if (validator.verdict === 'block') {
      return blockedVerdict(validator.reasons, validator.signals, techniqueForReasons(validator.reasons))
    }

    modelReached = true
    const run = await (deps.runAttempt ?? defaultRunAttempt)({ level, message })
    return evaluationVerdict(run.evaluation, validator, costOf(run, budget.reserveMicros, log))
  } catch (error) {
    // Our own fault, so it is refunded within the budget. A run that may have
    // reached the model settles its spend at the reservation, an upper bound.
    log('error', { event: 'attempt_pipeline_fault', level: started.levelId, error: errorName(error) })
    return errorVerdict('upstream_config', modelReached ? budget.reserveMicros : 0, validator)
  }
}

/** The actual spend; a usage that cannot be priced settles at the reservation, an upper bound. */
function costOf(run: AttemptRun, reserveMicros: number, log: ServiceLogger): number {
  try {
    return costMicrosFromUsage(run.usage)
  } catch (error) {
    log('error', { event: 'attempt_cost_unpriced', error: errorName(error) })
    return reserveMicros
  }
}

/**
 * record_attempt, with the R3-07 fallback: a value that cannot be stored
 * settles the attempt as error `reply_unstorable` with no reply, under the
 * refund budget, instead of leaving it pending.
 */
async function settle(
  rpc: AttemptRpc,
  userId: string,
  input: RecordAttemptInput,
  log: ServiceLogger
): Promise<RecordResult> {
  try {
    return await rpc.recordAttempt(userId, input)
  } catch (error) {
    if (!isUnstorable(error) || input.outcome === 'error') throw error
    log('error', {
      event: 'attempt_reply_unstorable',
      outcome: input.outcome,
      sqlstate: (error as { code?: string | null }).code ?? null,
    })
    return await rpc.recordAttempt(userId, {
      ...input,
      outcome: 'error',
      reply: null,
      tripwireProbability: null,
      canaryLeaked: false,
      toolCalled: false,
      errorCode: 'reply_unstorable',
      blockFingerprint: false,
    })
  }
}
