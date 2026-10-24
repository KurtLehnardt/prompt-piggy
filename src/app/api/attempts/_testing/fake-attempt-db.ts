import { randomUUID } from 'node:crypto'
import type { RpcClient, RpcResponse } from '@/lib/game/rpc'
import { SEED_RULE_SETS } from '@/lib/rules/seed'

/**
 * An in-memory stand-in for the attempt RPCs, for unit tests only (this
 * folder is private to the App Router and never imported by app code).
 *
 * It implements the PostgREST `rpc(fn, args)` surface that src/lib/game/rpc.ts
 * calls, following the PP-22 contract in docs/ARCHITECTURE.md section 5.4:
 * start_attempt debits the price before it returns, replays a finalized key,
 * refuses a pending key with `PT409 attempt_in_flight` and the hint JSON,
 * and refuses `pig_changed`, `insufficient_funds`, and
 * `level_not_configured` with nothing charged; record_attempt pays the whole
 * treasury on a paid win, adds a crack for fail, blocked, and leak_blocked,
 * refunds an error within the refund budget, and raises
 * `PT409 already_finalized` for a second call; attempt_result returns the
 * caller's own finalized attempt. The real functions live in migration
 * 00007; the integration test runs against them.
 */

type Player = { balance: number; cracks: number; donated: number; inFlight: string | null }

type Attempt = {
  id: string
  userId: string
  key: string
  levelId: number
  epoch: number
  prompt: string
  fingerprint: string
  priceCents: number
  createdAt: number
  outcome: string
  reply: string | null
  technique: string | null
  crackEvent: string | null
  cracksAfter: number | null
  payoutCents: number
  refundCents: number
  refundWithheld: boolean
  levelTo: number | null
  finalizedAt: number | null
}

export type FakeDbError = { code: string; message: string; hint?: string; details?: string; status?: number }

/** A scripted answer for the next call of a function, before (or instead of) the real behaviour. */
export type FakeInterceptor = (args: Record<string, unknown>) => RpcResponse | 'commit_then_lose' | null

export type FakeDbOptions = {
  priceCents?: number
  refundBudgetPerHour?: number
  levelSecrets?: Partial<Record<4 | 5, unknown>>
  /**
   * True (default): start_attempt reaps a stale same-key row itself and
   * replays it (R3-06 in SQL). False: it keeps answering attempt_in_flight
   * with retryAfterSeconds 0, so the service's own recovery must reap it.
   */
  sqlReapsStaleSameKey?: boolean
}

const PT_STATUS: Record<string, number> = { PT402: 402, PT409: 409, PT422: 422, PT429: 429, PT503: 503 }

function fail(error: FakeDbError): RpcResponse {
  return {
    data: null,
    error: { code: error.code, message: error.message, details: error.details ?? '', hint: error.hint ?? '' },
    status: error.status ?? PT_STATUS[error.code] ?? 400,
  }
}

function ok(data: unknown): RpcResponse {
  return { data, error: null, status: 200 }
}

export class FakeAttemptDb implements RpcClient {
  readonly players = new Map<string, Player>()
  readonly attempts = new Map<string, Attempt>()
  readonly blockedFingerprints = new Set<string>()
  readonly hardeningJobs: { id: string; attemptId: string; levelId: number }[] = []
  readonly calls: { fn: string; args: Record<string, unknown> }[] = []
  readonly game = { level: 1, epoch: 1, treasury: 0 }
  readonly config: { priceCents: number; refundBudgetPerHour: number; killSwitch: boolean; sqlReapsStaleSameKey: boolean }
  levelSecrets: Partial<Record<number, unknown>>
  now = Date.now()
  private readonly interceptors = new Map<string, FakeInterceptor[]>()
  private leaseHeldUntil = 0

  constructor(options: FakeDbOptions = {}) {
    this.config = {
      priceCents: options.priceCents ?? 100,
      refundBudgetPerHour: options.refundBudgetPerHour ?? 3,
      killSwitch: false,
      sqlReapsStaleSameKey: options.sqlReapsStaleSameKey ?? true,
    }
    this.levelSecrets = { ...(options.levelSecrets ?? {}) }
  }

  addPlayer(userId: string, state: Partial<Player> = {}): void {
    this.players.set(userId, { balance: 2000, cracks: 0, donated: 0, inFlight: null, ...state })
  }

  /** Queues a scripted answer for the next call of `fn`. */
  intercept(fn: string, interceptor: FakeInterceptor): void {
    const queue = this.interceptors.get(fn) ?? []
    queue.push(interceptor)
    this.interceptors.set(fn, queue)
  }

  callsTo(fn: string) {
    return this.calls.filter((call) => call.fn === fn)
  }

  aura(userId: string): number {
    const player = this.players.get(userId)!
    const total = player.donated + player.balance
    return total === 0 ? 0 : Math.floor((player.donated * 10_000) / total)
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<RpcResponse> {
    this.calls.push({ fn, args: structuredClone(args) })
    const interceptor = this.interceptors.get(fn)?.shift()
    if (interceptor) {
      const scripted = interceptor(args)
      if (scripted === 'commit_then_lose') {
        this.dispatch(fn, args)
        return { data: null, error: { code: '', message: 'TypeError: fetch failed', details: '', hint: '' }, status: 0 }
      }
      if (scripted) return scripted
    }
    return this.dispatch(fn, args)
  }

  private dispatch(fn: string, args: Record<string, unknown>): RpcResponse {
    switch (fn) {
      case 'start_attempt':
        return this.startAttempt(args)
      case 'record_attempt':
        return this.recordAttempt(args)
      case 'attempt_result':
        return this.attemptResult(String(args.p_user_id), String(args.p_attempt_id))
      case 'reap_stale_attempts':
        return ok(this.reap(Number(args.p_older_than_seconds)))
      case 'claim_lease': {
        if (this.leaseHeldUntil > this.now) return ok(null)
        this.leaseHeldUntil = this.now + Number(args.p_ttl_seconds) * 1000
        return ok(true)
      }
      default:
        return fail({ code: 'PGRST202', message: `unknown function ${fn}`, status: 404 })
    }
  }

  private findByKey(userId: string, key: string): Attempt | undefined {
    for (const attempt of this.attempts.values()) {
      if (attempt.userId === userId && attempt.key === key) return attempt
    }
    return undefined
  }

  private startRow(attempt: Attempt, replay: boolean) {
    const player = this.players.get(attempt.userId)!
    return [
      {
        attempt_id: attempt.id,
        level_id: attempt.levelId,
        pig_epoch: attempt.epoch,
        rule_set_id: '00000000-0000-4000-8000-00000000000' + attempt.levelId,
        rules: SEED_RULE_SETS[attempt.levelId as 1 | 2 | 3 | 4 | 5],
        rule_version: 0,
        level_secret: attempt.levelId >= 4 ? (this.levelSecrets[attempt.levelId] ?? null) : null,
        fingerprint_blocked: this.blockedFingerprints.has(attempt.fingerprint),
        price_cents: attempt.priceCents,
        wallet_balance_cents: player.balance,
        treasury_cents: this.game.treasury,
        replay,
      },
    ]
  }

  private secondsUntilStale(attempt: Attempt, staleSeconds: number): number {
    return Math.ceil(staleSeconds - (this.now - attempt.createdAt) / 1000)
  }

  private startAttempt(args: Record<string, unknown>): RpcResponse {
    const userId = String(args.p_user_id)
    const key = String(args.p_idempotency_key)
    const staleSeconds = Number(args.p_stale_seconds)
    const player = this.players.get(userId)
    if (!player) return fail({ code: 'PT422', message: 'invariant_violation: no wallet' })

    const existing = this.findByKey(userId, key)
    if (existing && existing.outcome !== 'pending') return ok(this.startRow(existing, true))
    if (existing) {
      const seconds = this.secondsUntilStale(existing, staleSeconds)
      if (seconds > 0 || !this.config.sqlReapsStaleSameKey) {
        return fail({
          code: 'PT409',
          message: 'attempt_in_flight',
          hint: JSON.stringify({ sameKey: true, retryAfterSeconds: Math.max(0, seconds) }),
        })
      }
      // R3-06 in SQL: the stale same-key row is reaped under the lock and replayed.
      this.finalizeError(existing, 'reaped')
      return ok(this.startRow(existing, true))
    }
    if (this.config.killSwitch) return fail({ code: 'PT503', message: 'kill_switch' })

    if (player.inFlight) {
      const other = this.attempts.get(player.inFlight)!
      const seconds = this.secondsUntilStale(other, staleSeconds)
      if (seconds > 0) {
        return fail({
          code: 'PT409',
          message: 'attempt_in_flight',
          hint: JSON.stringify({ sameKey: false, retryAfterSeconds: seconds }),
        })
      }
      this.finalizeError(other, 'reaped')
    }
    if (player.balance < this.config.priceCents) {
      return fail({
        code: 'PT402',
        message: 'insufficient_funds',
        hint: JSON.stringify({ balanceCents: player.balance, priceCents: this.config.priceCents }),
      })
    }
    if (this.game.epoch !== Number(args.p_expected_epoch)) {
      return fail({
        code: 'PT409',
        message: 'pig_changed',
        hint: JSON.stringify({ pigEpoch: this.game.epoch, level: this.game.level }),
      })
    }
    if (this.game.level >= 4 && this.levelSecrets[this.game.level] === undefined) {
      return fail({ code: 'PT503', message: 'level_not_configured' })
    }

    const attempt: Attempt = {
      id: randomUUID(),
      userId,
      key,
      levelId: this.game.level,
      epoch: this.game.epoch,
      prompt: String(args.p_prompt),
      fingerprint: String(args.p_prompt_fingerprint),
      priceCents: this.config.priceCents,
      createdAt: this.now,
      outcome: 'pending',
      reply: null,
      technique: null,
      crackEvent: null,
      cracksAfter: null,
      payoutCents: 0,
      refundCents: 0,
      refundWithheld: false,
      levelTo: null,
      finalizedAt: null,
    }
    player.balance -= attempt.priceCents
    this.game.treasury += attempt.priceCents
    player.inFlight = attempt.id
    this.attempts.set(attempt.id, attempt)
    return ok(this.startRow(attempt, false))
  }

  private finalizeError(attempt: Attempt, code: string): { refund: number; withheld: boolean } {
    const player = this.players.get(attempt.userId)!
    const hourAgo = this.now - 3_600_000
    const recent = [...this.attempts.values()].filter(
      (a) => a.userId === attempt.userId && a.refundCents > 0 && (a.finalizedAt ?? 0) > hourAgo
    ).length
    let refund = 0
    let withheld = false
    if (recent < this.config.refundBudgetPerHour) {
      refund = attempt.priceCents
      player.balance += refund
      if (attempt.epoch === this.game.epoch) this.game.treasury -= refund
    } else {
      withheld = true
    }
    Object.assign(attempt, {
      outcome: 'error',
      refundCents: refund,
      refundWithheld: withheld,
      crackEvent: 'none',
      cracksAfter: player.cracks,
      finalizedAt: this.now,
      technique: attempt.technique ?? 'unclassified',
      errorCode: code,
    })
    if (player.inFlight === attempt.id) player.inFlight = null
    return { refund, withheld }
  }

  private settlementRow(attempt: Attempt, levelFrom: number | null, jobId: string | null) {
    const player = this.players.get(attempt.userId)!
    return [
      {
        outcome: attempt.outcome,
        crack_event: attempt.crackEvent,
        cracks_after: attempt.cracksAfter,
        payout_cents: attempt.payoutCents,
        refund_cents: attempt.refundCents,
        refund_withheld: attempt.refundWithheld,
        wallet_balance_cents: player.balance,
        aura_bps: this.aura(attempt.userId),
        treasury_cents: this.game.treasury,
        current_level: this.game.level,
        pig_epoch: this.game.epoch,
        level_from: levelFrom,
        level_to: attempt.levelTo,
        hardening_job_id: jobId,
      },
    ]
  }

  private recordAttempt(args: Record<string, unknown>): RpcResponse {
    const attempt = this.attempts.get(String(args.p_attempt_id))
    if (!attempt) return fail({ code: 'PT404', message: 'not_found', status: 404 })
    const outcome = String(args.p_outcome)
    if (args.p_block_fingerprint === true && outcome !== 'win') {
      return fail({ code: 'PT422', message: 'invariant_violation: block_fingerprint needs a win' })
    }
    if (outcome === 'error' && !args.p_error_code) {
      return fail({ code: 'PT422', message: 'invariant_violation: error needs a code' })
    }
    if (typeof args.p_reply === 'string' && args.p_reply.includes('\u0000')) {
      return fail({ code: '22P05', message: 'unsupported Unicode escape sequence', status: 400 })
    }
    if (attempt.outcome !== 'pending') return fail({ code: 'PT409', message: 'already_finalized' })

    const player = this.players.get(attempt.userId)!
    attempt.technique = String(args.p_technique)
    attempt.reply = (args.p_reply as string | null) ?? null
    if (outcome === 'error') {
      this.finalizeError(attempt, String(args.p_error_code))
      return ok(this.settlementRow(attempt, null, null))
    }

    let levelFrom: number | null = null
    let jobId: string | null = null
    if (outcome === 'win') {
      if (attempt.epoch === this.game.epoch) {
        attempt.outcome = 'win'
        attempt.payoutCents = this.game.treasury
        player.balance += this.game.treasury
        this.game.treasury = 0
        levelFrom = this.game.level
        attempt.levelTo = Math.min(this.game.level + 1, 5)
        this.game.level = attempt.levelTo
        this.game.epoch += 1
        if (args.p_block_fingerprint === true) this.blockedFingerprints.add(attempt.fingerprint)
        jobId = randomUUID()
        this.hardeningJobs.push({ id: jobId, attemptId: attempt.id, levelId: levelFrom })
      } else {
        attempt.outcome = 'late_win'
      }
      attempt.crackEvent = 'none'
    } else {
      const next = Math.min(3, player.cracks + 1)
      attempt.crackEvent = player.cracks < 3 && next === 3 ? 'shatter' : next > player.cracks ? 'crack' : 'none'
      player.cracks = next
      attempt.outcome = outcome
    }
    attempt.cracksAfter = player.cracks
    attempt.finalizedAt = this.now
    if (player.inFlight === attempt.id) player.inFlight = null
    return ok(this.settlementRow(attempt, levelFrom, jobId))
  }

  private attemptResult(userId: string, attemptId: string): RpcResponse {
    const attempt = this.attempts.get(attemptId)
    if (!attempt || attempt.userId !== userId || attempt.outcome === 'pending') return ok([])
    const player = this.players.get(userId)!
    return ok([
      {
        outcome: attempt.outcome,
        crack_event: attempt.crackEvent,
        cracks_after: attempt.cracksAfter,
        payout_cents: attempt.payoutCents,
        refund_cents: attempt.refundCents,
        refund_withheld: attempt.refundWithheld,
        level_id: attempt.levelId,
        level_to: attempt.outcome === 'win' ? attempt.levelTo : null,
        technique: attempt.technique,
        reply: attempt.reply,
        wallet_balance_cents: player.balance,
        aura_bps: this.aura(userId),
        treasury_cents: this.game.treasury,
        current_level: this.game.level,
        pig_epoch: this.game.epoch,
      },
    ])
  }

  private reap(olderThanSeconds: number): number {
    let count = 0
    for (const attempt of this.attempts.values()) {
      if (attempt.outcome === 'pending' && this.now - attempt.createdAt > olderThanSeconds * 1000) {
        this.finalizeError(attempt, 'reaped')
        count += 1
      }
    }
    return count
  }
}
