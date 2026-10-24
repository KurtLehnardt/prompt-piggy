import 'server-only'
import { z } from 'zod'
import { ATTACK_TECHNIQUES, type AttackTechnique } from '@/lib/config/techniques'
import type { LevelId } from '@/lib/config/levels'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  ATTEMPT_OUTCOMES,
  CRACK_EVENTS,
  LevelIdSchema,
  type AttemptOutcome,
  type CrackCount,
  type CrackEvent,
} from '@/types/api'

/**
 * The attempt RPC layer (docs/ARCHITECTURE.md sections 5.1 and 5.4; REVIEW-1
 * R1-02; REVIEW-2 R2-05, R2-14; REVIEW-3 R3-06, R3-07).
 *
 * It is the only code that calls the attempt functions of migration 00007
 * (start_attempt, record_attempt, attempt_result) and the attempt helpers of
 * 00005 and 00006 (claim_lease, reap_stale_attempts). Every function is
 * service_role only, so the calls go through the secret-key client, which is
 * created only here and in attempt-service.ts, and only after the route has
 * verified the user with getUser().
 *
 * - Text: the attacker's message travels only as `p_prompt` to start_attempt,
 *   and model text only as `p_reply` to record_attempt. Every other parameter
 *   is a number, a boolean, an id, a hash, or an enum code (R1-02, HC3).
 * - Results: every row is parsed with zod. The start result is reduced to
 *   what the pipeline needs; it carries no wallet or player state (HC3).
 *   The settlement and stored-result rows are returned as the database
 *   computed them, and nothing here does arithmetic on money, cracks, aura,
 *   or levels (HC-A5).
 * - Retries (section 5.1): start_attempt is retried once on SQLSTATE 40P01
 *   (deadlock) or 40001 (serialization failure). record_attempt is retried up
 *   to three times, after 100, 400, and 1,600 ms, on a network error, a
 *   PostgREST 5xx, 40P01, or 40001. A `PT409 already_finalized` answer means
 *   an earlier call committed, so the stored result is read back with
 *   attempt_result and returned as success (R2-14). Every retry is logged at
 *   error level with the function name, the SQLSTATE, and the HTTP status,
 *   never with parameters, messages, details, or hints, which can hold
 *   prompts and replies (T25).
 */

// ---------------------------------------------------------------------------
// The client seam

/** What postgrest-js resolves for an RPC: status 0 means the request never got an HTTP answer. */
export type RpcResponse = { data: unknown; error: unknown; status?: number }

/** The one method of the Supabase client this module uses. Tests pass a fake. */
export type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResponse>
}

/**
 * A failed RPC. It keeps the PostgREST error fields, so mapRpcError() in
 * src/lib/errors.ts can read the SQLSTATE, the message token, and the hint.
 * Those fields stay inside this object: callers log `fn`, `code`, and
 * `status` only.
 */
export class RpcError extends Error {
  readonly fn: string
  readonly code: string | null
  readonly details: string
  readonly hint: string
  readonly status: number | null

  constructor(fn: string, fields: { code: string | null; message: string; details: string; hint: string; status: number | null }) {
    super(fields.message)
    this.name = 'RpcError'
    this.fn = fn
    this.code = fields.code
    this.details = fields.details
    this.hint = fields.hint
    this.status = fields.status
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toRpcError(fn: string, error: unknown, status: number | null): RpcError {
  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : null
  return new RpcError(fn, {
    code,
    message: text(record.message),
    details: text(record.details),
    hint: text(record.hint),
    status,
  })
}

/** SQLSTATEs that mean "run the same transaction again". */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '40001'])

/** True for a lock conflict that start_attempt may retry once. */
export function isLockConflict(error: unknown): boolean {
  return error instanceof RpcError && error.code !== null && RETRYABLE_SQLSTATES.has(error.code)
}

/**
 * True for a failure that record_attempt may retry: no HTTP answer at all
 * (status 0 or a thrown fetch), a PostgREST 5xx that is not one of our own
 * PTnnn raises, or a lock conflict.
 */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false
  if (isLockConflict(error)) return true
  if (error.status === null || error.status === 0) return true
  return error.status >= 500 && !(error.code ?? '').startsWith('PT')
}

/** True for `PT409 already_finalized`: an earlier record_attempt call committed. */
export function isAlreadyFinalized(error: unknown): boolean {
  return error instanceof RpcError && error.code === 'PT409' && /\balready_finalized\b/.test(error.message)
}

/**
 * True when record_attempt failed because a value could not be stored: a
 * Postgres data exception (SQLSTATE class 22, such as 22P05 for a character
 * that text cannot hold) or a CHECK violation (23514, such as the reply
 * length). The attempt service then settles the attempt as an error under the
 * refund budget (R3-07).
 */
export function isUnstorable(error: unknown): boolean {
  if (!(error instanceof RpcError) || error.code === null) return false
  return error.code.startsWith('22') || error.code === '23514'
}

export type RpcLogger = (level: 'error', entry: Record<string, string | number | boolean | null>) => void

const consoleLogger: RpcLogger = (_level, entry) => {
  console.error(JSON.stringify(entry))
}

export type AttemptRpcOptions = {
  /** Default: the secret-key client, created on the first call. */
  client?: RpcClient
  /** Default: setTimeout. Tests pass an instant sleep. */
  sleep?: (ms: number) => Promise<void>
  log?: RpcLogger
}

/** The waits before the three record_attempt retries, in milliseconds. */
export const RECORD_RETRY_DELAYS_MS = Object.freeze([100, 400, 1600] as const)

// ---------------------------------------------------------------------------
// Parameters

export type StartAttemptInput = {
  userId: string
  idempotencyKey: string
  expectedEpoch: number
  /** The attacker's message: stored only (HC3). */
  prompt: string
  promptSha256: string
  promptFingerprint: string
  reserveMicros: number
  dailyCapMicros: number
  attemptShareBps: number
  rateCapacity: number
  rateRefillPerMin: number
  dailyAttemptCap: number
  staleSeconds: number
}

/** The outcomes the attempt service may ask record_attempt for. late_win is decided in SQL. */
export type RecordableOutcome = Exclude<AttemptOutcome, 'late_win'>

export type RecordAttemptInput = {
  attemptId: string
  outcome: RecordableOutcome
  /** Model text for a fail, otherwise null: stored only (HC3). */
  reply: string | null
  validatorReasons: readonly string[]
  validatorSignals: readonly string[]
  tripwireProbability: number | null
  technique: AttackTechnique
  canaryLeaked: boolean
  toolCalled: boolean
  costMicros: number
  errorCode: string | null
  blockFingerprint: boolean
  userJobsPerHour: number
}

/** start_attempt's parameters (00007). rpc.test.ts checks the names against src/types/database.ts. */
export type StartAttemptArgs = {
  p_user_id: string
  p_idempotency_key: string
  p_expected_epoch: number
  p_prompt: string
  p_prompt_sha256: string
  p_prompt_fingerprint: string
  p_reserve_micros: number
  p_daily_cap_micros: number
  p_attempt_share_bps: number
  p_rate_capacity: number
  p_rate_refill_per_min: number
  p_daily_attempt_cap: number
  p_stale_seconds: number
}

/** record_attempt's parameters (00007). The generated types cannot express the nullable ones. */
export type RecordAttemptArgs = {
  p_attempt_id: string
  p_outcome: RecordableOutcome
  p_reply: string | null
  p_validator_reasons: string[]
  p_validator_signals: string[]
  p_tripwire_probability: number | null
  p_technique: AttackTechnique
  p_canary_leaked: boolean
  p_tool_called: boolean
  p_cost_micros: number
  p_error_code: string | null
  p_block_fingerprint: boolean
  p_user_jobs_per_hour: number
}

function startArgs(input: StartAttemptInput): StartAttemptArgs {
  return {
    p_user_id: input.userId,
    p_idempotency_key: input.idempotencyKey,
    p_expected_epoch: input.expectedEpoch,
    p_prompt: input.prompt,
    p_prompt_sha256: input.promptSha256,
    p_prompt_fingerprint: input.promptFingerprint,
    p_reserve_micros: input.reserveMicros,
    p_daily_cap_micros: input.dailyCapMicros,
    p_attempt_share_bps: input.attemptShareBps,
    p_rate_capacity: input.rateCapacity,
    p_rate_refill_per_min: input.rateRefillPerMin,
    p_daily_attempt_cap: input.dailyAttemptCap,
    p_stale_seconds: input.staleSeconds,
  }
}

function recordArgs(input: RecordAttemptInput): RecordAttemptArgs {
  return {
    p_attempt_id: input.attemptId,
    p_outcome: input.outcome,
    p_reply: input.reply,
    p_validator_reasons: [...input.validatorReasons],
    p_validator_signals: [...input.validatorSignals],
    p_tripwire_probability: input.tripwireProbability,
    p_technique: input.technique,
    p_canary_leaked: input.canaryLeaked,
    p_tool_called: input.toolCalled,
    p_cost_micros: input.costMicros,
    p_error_code: input.errorCode,
    p_block_fingerprint: input.blockFingerprint,
    p_user_jobs_per_hour: input.userJobsPerHour,
  }
}

// ---------------------------------------------------------------------------
// Results

const Uuid = z.uuid()
const Count = z.int()
const NonNegative = z.int().min(0)
const Outcome = z.enum(ATTEMPT_OUTCOMES)
const Crack = z.enum(CRACK_EVENTS)
const Cracks = z.literal([0, 1, 2, 3])
const Technique = z.enum(ATTACK_TECHNIQUES)

const StartRowSchema = z.object({
  attempt_id: Uuid,
  level_id: LevelIdSchema,
  pig_epoch: Count,
  rule_set_id: Uuid.nullable().optional(),
  rules: z.unknown().optional(),
  rule_version: Count.nullable().optional(),
  level_secret: z.unknown().optional(),
  fingerprint_blocked: z.boolean().nullable().optional(),
  price_cents: z.int().min(1),
  replay: z.boolean(),
})

const SettlementRowSchema = z.object({
  outcome: Outcome,
  crack_event: Crack,
  cracks_after: Cracks,
  payout_cents: NonNegative,
  refund_cents: NonNegative,
  refund_withheld: z.boolean(),
  wallet_balance_cents: Count,
  aura_bps: z.int().min(0).max(10_000),
  treasury_cents: Count,
  current_level: LevelIdSchema,
  pig_epoch: Count,
  level_from: LevelIdSchema.nullable(),
  level_to: LevelIdSchema.nullable(),
  hardening_job_id: Uuid.nullable(),
})

/** record_attempt's row as parsed; rpc.test.ts checks its columns against src/types/database.ts. */
export type SettlementRow = z.infer<typeof SettlementRowSchema>

const StoredRowSchema = z.object({
  outcome: Outcome,
  crack_event: Crack,
  cracks_after: Cracks,
  payout_cents: NonNegative,
  refund_cents: NonNegative,
  refund_withheld: z.boolean(),
  level_id: LevelIdSchema,
  level_to: LevelIdSchema.nullable(),
  technique: Technique.nullable(),
  reply: z.string().nullable(),
  wallet_balance_cents: Count,
  aura_bps: z.int().min(0).max(10_000),
  treasury_cents: Count,
  current_level: LevelIdSchema,
  pig_epoch: Count,
})

/** attempt_result's row as parsed; rpc.test.ts checks its columns against src/types/database.ts. */
export type StoredRow = z.infer<typeof StoredRowSchema>

/** The start_attempt columns the service reads; wallet_balance_cents and treasury_cents are dropped (HC3). */
export type StartRow = z.infer<typeof StartRowSchema>

/**
 * What start_attempt returned, reduced to what the pipeline needs. There is
 * no wallet balance, treasury, aura, or crack count here (HC3).
 */
export type StartedAttempt = {
  attemptId: string
  /** The pinned level this attempt faces. */
  levelId: LevelId
  pigEpoch: number
  /** The pinned active rule set (null only on a replay). */
  rules: unknown
  ruleVersion: number | null
  /** The level_secrets payload at levels 4 and 5, null at levels 1 to 3. */
  levelSecret: unknown
  fingerprintBlocked: boolean
  priceCents: number
  /** True: a finalized attempt with this key exists; read it with attemptResult(). */
  replay: boolean
}

/** record_attempt's return values, unchanged (section 5.4). */
export type AttemptSettlement = {
  outcome: AttemptOutcome
  crackEvent: CrackEvent
  cracksAfter: CrackCount
  payoutCents: number
  refundCents: number
  refundWithheld: boolean
  walletBalanceCents: number
  auraBps: number
  treasuryCents: number
  currentLevel: LevelId
  pigEpoch: number
  levelFrom: LevelId | null
  levelTo: LevelId | null
  hardeningJobId: string | null
}

/** attempt_result's return values, unchanged (section 5.4, R2-05, R2-14). */
export type StoredAttempt = {
  outcome: AttemptOutcome
  crackEvent: CrackEvent
  cracksAfter: CrackCount
  payoutCents: number
  refundCents: number
  refundWithheld: boolean
  levelId: LevelId
  levelTo: LevelId | null
  technique: AttackTechnique | null
  reply: string | null
  walletBalanceCents: number
  auraBps: number
  treasuryCents: number
  currentLevel: LevelId
  pigEpoch: number
}

/** A record_attempt call that this request committed, or one an earlier call committed (read back). */
export type RecordResult =
  | { source: 'recorded'; settlement: AttemptSettlement }
  | { source: 'stored'; stored: StoredAttempt }

/** A row shape that does not match the contract; the message names the function only. */
export class RpcShapeError extends Error {
  readonly fn: string

  constructor(fn: string) {
    super(`${fn} returned an unexpected row.`)
    this.name = 'RpcShapeError'
    this.fn = fn
  }
}

function firstRow(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data
}

function parseStart(data: unknown): StartedAttempt {
  const parsed = StartRowSchema.safeParse(firstRow(data))
  if (!parsed.success) throw new RpcShapeError('start_attempt')
  const row = parsed.data
  return {
    attemptId: row.attempt_id,
    levelId: row.level_id,
    pigEpoch: row.pig_epoch,
    rules: row.rules ?? null,
    ruleVersion: row.rule_version ?? null,
    levelSecret: row.level_secret ?? null,
    fingerprintBlocked: row.fingerprint_blocked === true,
    priceCents: row.price_cents,
    replay: row.replay,
  }
}

function parseSettlement(data: unknown): AttemptSettlement | null {
  const parsed = SettlementRowSchema.safeParse(firstRow(data))
  if (!parsed.success) return null
  const row = parsed.data
  return {
    outcome: row.outcome,
    crackEvent: row.crack_event,
    cracksAfter: row.cracks_after,
    payoutCents: row.payout_cents,
    refundCents: row.refund_cents,
    refundWithheld: row.refund_withheld,
    walletBalanceCents: row.wallet_balance_cents,
    auraBps: row.aura_bps,
    treasuryCents: row.treasury_cents,
    currentLevel: row.current_level,
    pigEpoch: row.pig_epoch,
    levelFrom: row.level_from,
    levelTo: row.level_to,
    hardeningJobId: row.hardening_job_id,
  }
}

function parseStored(data: unknown): StoredAttempt | null {
  const row = firstRow(data)
  if (row === undefined || row === null) return null
  const parsed = StoredRowSchema.safeParse(row)
  if (!parsed.success) throw new RpcShapeError('attempt_result')
  const value = parsed.data
  return {
    outcome: value.outcome,
    crackEvent: value.crack_event,
    cracksAfter: value.cracks_after,
    payoutCents: value.payout_cents,
    refundCents: value.refund_cents,
    refundWithheld: value.refund_withheld,
    levelId: value.level_id,
    levelTo: value.level_to,
    technique: value.technique,
    reply: value.reply,
    walletBalanceCents: value.wallet_balance_cents,
    auraBps: value.aura_bps,
    treasuryCents: value.treasury_cents,
    currentLevel: value.current_level,
    pigEpoch: value.pig_epoch,
  }
}

// ---------------------------------------------------------------------------
// The RPC layer

export type AttemptRpc = {
  /** Debits the price and pins the level, or throws an RpcError that mapRpcError() maps (section 7). */
  startAttempt(input: StartAttemptInput): Promise<StartedAttempt>
  /** Finalizes the attempt, with the retries above; PT409 already_finalized reads the stored result back. */
  recordAttempt(userId: string, input: RecordAttemptInput): Promise<RecordResult>
  /** The caller's own finalized attempt, or null for a pending or foreign one. */
  attemptResult(userId: string, attemptId: string): Promise<StoredAttempt | null>
  /** Finalizes pending attempts older than the threshold as error `reaped`; returns the count. */
  reapStaleAttempts(olderThanSeconds: number, limit: number): Promise<number>
  /** True only for the caller that got the lease (claim_lease returns NULL to everyone else). */
  claimLease(key: string, ttlSeconds: number): Promise<boolean>
}

/** Builds the RPC layer. Without a client it creates the secret-key client on the first call. */
export function createAttemptRpc(options: AttemptRpcOptions = {}): AttemptRpc {
  let client = options.client ?? null
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? consoleLogger

  function getClient(): RpcClient {
    client ??= createAdminClient() as unknown as RpcClient
    return client
  }

  async function call(fn: string, args: StartAttemptArgs | RecordAttemptArgs | Record<string, unknown>): Promise<unknown> {
    let response: RpcResponse
    try {
      response = await getClient().rpc(fn, args as Record<string, unknown>)
    } catch (error) {
      if (error instanceof Error && /not configured/.test(error.message)) throw error
      throw toRpcError(fn, { message: 'The request failed before an answer arrived.' }, null)
    }
    const status = typeof response.status === 'number' ? response.status : null
    if (response.error) throw toRpcError(fn, response.error, status)
    return response.data
  }

  function logRetry(fn: string, retry: number, error: unknown): void {
    const rpcError = error instanceof RpcError ? error : null
    log('error', {
      event: 'attempt_rpc_retry',
      fn,
      retry,
      sqlstate: rpcError?.code ?? null,
      status: rpcError?.status ?? null,
    })
  }

  async function attemptResult(userId: string, attemptId: string): Promise<StoredAttempt | null> {
    return parseStored(await call('attempt_result', { p_user_id: userId, p_attempt_id: attemptId }))
  }

  async function readBack(userId: string, attemptId: string): Promise<RecordResult> {
    const stored = await attemptResult(userId, attemptId)
    if (!stored) throw new RpcShapeError('attempt_result')
    return { source: 'stored', stored }
  }

  return {
    async startAttempt(input) {
      const args = startArgs(input)
      try {
        return parseStart(await call('start_attempt', args))
      } catch (error) {
        if (!isLockConflict(error)) throw error
        logRetry('start_attempt', 1, error)
        return parseStart(await call('start_attempt', args))
      }
    },

    async recordAttempt(userId, input) {
      const args = recordArgs(input)
      for (let retry = 0; ; retry += 1) {
        try {
          const settlement = parseSettlement(await call('record_attempt', args))
          if (settlement) return { source: 'recorded', settlement }
          // A committed record whose row lacks a field: the stored result is authoritative.
          log('error', { event: 'attempt_rpc_shape', fn: 'record_attempt' })
          return await readBack(userId, input.attemptId)
        } catch (error) {
          if (isAlreadyFinalized(error)) return await readBack(userId, input.attemptId)
          if (!isTransient(error) || retry >= RECORD_RETRY_DELAYS_MS.length) throw error
          logRetry('record_attempt', retry + 1, error)
          await sleep(RECORD_RETRY_DELAYS_MS[retry])
        }
      }
    },

    attemptResult,

    async reapStaleAttempts(olderThanSeconds, limit) {
      const data = await call('reap_stale_attempts', { p_older_than_seconds: olderThanSeconds, p_limit: limit })
      return typeof data === 'number' && Number.isSafeInteger(data) ? data : 0
    },

    async claimLease(key, ttlSeconds) {
      return (await call('claim_lease', { p_key: key, p_ttl_seconds: ttlSeconds })) === true
    },
  }
}
