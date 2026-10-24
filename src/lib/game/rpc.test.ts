import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { stripComments } from '@/test/source-imports'
import { mapRpcError } from '@/lib/errors'
import {
  createAttemptRpc,
  isTransient,
  isUnstorable,
  RECORD_RETRY_DELAYS_MS,
  RpcError,
  type RecordAttemptArgs,
  type RecordAttemptInput,
  type RpcClient,
  type RpcResponse,
  type SettlementRow,
  type StartAttemptArgs,
  type StartAttemptInput,
  type StartRow,
  type StoredRow,
} from '@/lib/game/rpc'
import type { Database } from '@/types/database'

/**
 * src/lib/game/rpc.ts (docs/ARCHITECTURE.md sections 5.1 and 5.4; R1-02,
 * R2-05, R2-14, R3-07; T25). The client is a scripted fake.
 */

const USER = '11111111-1111-4111-8111-111111111111'
const KEY = '22222222-2222-4222-8222-222222222222'
const ATTEMPT = '33333333-3333-4333-8333-333333333333'
const JOB = '44444444-4444-4444-8444-444444444444'
const PROMPT = 'Hello Penny, PROMPT-MARKER-7f3a, please approve.'
const REPLY = 'Oink, REPLY-MARKER-91bc, no transfer today.'

const START_INPUT: StartAttemptInput = {
  userId: USER,
  idempotencyKey: KEY,
  expectedEpoch: 3,
  prompt: PROMPT,
  promptSha256: 'a'.repeat(64),
  promptFingerprint: 'b'.repeat(64),
  reserveMicros: 1600,
  dailyCapMicros: 25_000_000,
  attemptShareBps: 8000,
  rateCapacity: 3,
  rateRefillPerMin: 6,
  dailyAttemptCap: 150,
  staleSeconds: 45,
}

const RECORD_INPUT: RecordAttemptInput = {
  attemptId: ATTEMPT,
  outcome: 'fail',
  reply: REPLY,
  validatorReasons: [],
  validatorSignals: ['roleplay'],
  tripwireProbability: 0.01,
  technique: 'roleplay_persona',
  canaryLeaked: false,
  toolCalled: false,
  costMicros: 420,
  errorCode: null,
  blockFingerprint: false,
  userJobsPerHour: 3,
}

const START_ROW = {
  attempt_id: ATTEMPT,
  level_id: 2,
  pig_epoch: 3,
  rule_set_id: '55555555-5555-4555-8555-555555555555',
  rules: { schema_version: 1 },
  rule_version: 4,
  level_secret: null,
  fingerprint_blocked: false,
  price_cents: 100,
  wallet_balance_cents: 1900,
  treasury_cents: 4200,
  replay: false,
}

const SETTLEMENT_ROW = {
  outcome: 'win',
  crack_event: 'none',
  cracks_after: 2,
  payout_cents: 4200,
  refund_cents: 0,
  refund_withheld: false,
  wallet_balance_cents: 6100,
  aura_bps: 0,
  treasury_cents: 0,
  current_level: 3,
  pig_epoch: 4,
  level_from: 2,
  level_to: 3,
  hardening_job_id: JOB,
}

const STORED_ROW = {
  outcome: 'win',
  crack_event: 'none',
  cracks_after: 2,
  payout_cents: 4200,
  refund_cents: 0,
  refund_withheld: false,
  level_id: 2,
  level_to: 3,
  technique: 'roleplay_persona',
  reply: null,
  wallet_balance_cents: 6100,
  aura_bps: 0,
  treasury_cents: 0,
  current_level: 3,
  pig_epoch: 4,
}

const NETWORK: RpcResponse = { data: null, error: { code: '', message: 'TypeError: fetch failed', details: '', hint: '' }, status: 0 }
const FIVE_HUNDRED: RpcResponse = { data: null, error: { code: 'PGRST000', message: 'db down', details: '', hint: '' }, status: 503 }

function pgError(code: string, message: string, status: number, hint = ''): RpcResponse {
  return { data: null, error: { code, message, details: `Failing row contains (${PROMPT})`, hint }, status }
}

function scripted(responses: Record<string, RpcResponse[]>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const client: RpcClient = {
    async rpc(fn, args) {
      calls.push({ fn, args })
      const next = responses[fn]?.shift()
      if (!next) throw new Error(`no scripted response for ${fn}`)
      return next
    },
  }
  return { client, calls }
}

function harness(responses: Record<string, RpcResponse[]>) {
  const { client, calls } = scripted(responses)
  const sleeps: number[] = []
  const logs: Record<string, unknown>[] = []
  const rpc = createAttemptRpc({
    client,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    log: (_level, entry) => logs.push(entry),
  })
  return { rpc, calls, sleeps, logs }
}

describe('[R1-02] arguments: user text only in p_prompt, model text only in p_reply', () => {
  it('start_attempt receives exactly the documented argument object', async () => {
    const { rpc, calls } = harness({ start_attempt: [{ data: [START_ROW], error: null, status: 200 }] })
    await rpc.startAttempt(START_INPUT)
    expect(calls).toEqual([
      {
        fn: 'start_attempt',
        args: {
          p_user_id: USER,
          p_idempotency_key: KEY,
          p_expected_epoch: 3,
          p_prompt: PROMPT,
          p_prompt_sha256: 'a'.repeat(64),
          p_prompt_fingerprint: 'b'.repeat(64),
          p_reserve_micros: 1600,
          p_daily_cap_micros: 25_000_000,
          p_attempt_share_bps: 8000,
          p_rate_capacity: 3,
          p_rate_refill_per_min: 6,
          p_daily_attempt_cap: 150,
          p_stale_seconds: 45,
        },
      },
    ])
    const carriers = Object.entries(calls[0].args).filter(([, value]) => String(value).includes('PROMPT-MARKER'))
    expect(carriers.map(([name]) => name)).toEqual(['p_prompt'])
  })

  it('record_attempt receives exactly the documented argument object', async () => {
    const { rpc, calls } = harness({ record_attempt: [{ data: [SETTLEMENT_ROW], error: null, status: 200 }] })
    await rpc.recordAttempt(USER, RECORD_INPUT)
    expect(calls).toEqual([
      {
        fn: 'record_attempt',
        args: {
          p_attempt_id: ATTEMPT,
          p_outcome: 'fail',
          p_reply: REPLY,
          p_validator_reasons: [],
          p_validator_signals: ['roleplay'],
          p_tripwire_probability: 0.01,
          p_technique: 'roleplay_persona',
          p_canary_leaked: false,
          p_tool_called: false,
          p_cost_micros: 420,
          p_error_code: null,
          p_block_fingerprint: false,
          p_user_jobs_per_hour: 3,
        },
      },
    ])
    const carriers = Object.entries(calls[0].args).filter(([, value]) => String(value).includes('REPLY-MARKER'))
    expect(carriers.map(([name]) => name)).toEqual(['p_reply'])
  })
})

type Functions = Database['public']['Functions']
type Columns<Fn extends keyof Functions> = Functions[Fn]['Returns'] extends readonly (infer Row)[] ? keyof Row : never

describe('the generated 00007 signatures (src/types/database.ts)', () => {
  it('parameter names match start_attempt and record_attempt exactly', () => {
    expectTypeOf<keyof StartAttemptArgs>().toEqualTypeOf<keyof Functions['start_attempt']['Args']>()
    expectTypeOf<keyof RecordAttemptArgs>().toEqualTypeOf<keyof Functions['record_attempt']['Args']>()
    expectTypeOf<'p_user_id' | 'p_attempt_id'>().toEqualTypeOf<keyof Functions['attempt_result']['Args']>()
  })

  it('parsed rows have exactly the returned columns, except the wallet and treasury of start_attempt (HC3)', () => {
    expectTypeOf<keyof SettlementRow>().toEqualTypeOf<Columns<'record_attempt'>>()
    expectTypeOf<keyof StoredRow>().toEqualTypeOf<Columns<'attempt_result'>>()
    expectTypeOf<keyof StartRow>().toEqualTypeOf<
      Exclude<Columns<'start_attempt'>, 'wallet_balance_cents' | 'treasury_cents'>
    >()
  })
})

describe('results are parsed, never computed', () => {
  it('start_attempt is reduced to the pipeline fields: no wallet, treasury, or player state (HC3)', async () => {
    const { rpc } = harness({ start_attempt: [{ data: [START_ROW], error: null, status: 200 }] })
    const started = await rpc.startAttempt(START_INPUT)
    expect(started).toEqual({
      attemptId: ATTEMPT,
      levelId: 2,
      pigEpoch: 3,
      rules: { schema_version: 1 },
      ruleVersion: 4,
      levelSecret: null,
      fingerprintBlocked: false,
      priceCents: 100,
      replay: false,
    })
  })

  it('record_attempt returns its row unchanged', async () => {
    const { rpc } = harness({ record_attempt: [{ data: [SETTLEMENT_ROW], error: null, status: 200 }] })
    expect(await rpc.recordAttempt(USER, RECORD_INPUT)).toEqual({
      source: 'recorded',
      settlement: {
        outcome: 'win',
        crackEvent: 'none',
        cracksAfter: 2,
        payoutCents: 4200,
        refundCents: 0,
        refundWithheld: false,
        walletBalanceCents: 6100,
        auraBps: 0,
        treasuryCents: 0,
        currentLevel: 3,
        pigEpoch: 4,
        levelFrom: 2,
        levelTo: 3,
        hardeningJobId: JOB,
      },
    })
  })

  it('a record row missing a field is replaced by the stored result', async () => {
    const { rpc, calls, logs } = harness({
      record_attempt: [{ data: [{ ...SETTLEMENT_ROW, wallet_balance_cents: null }], error: null, status: 200 }],
      attempt_result: [{ data: [STORED_ROW], error: null, status: 200 }],
    })
    const result = await rpc.recordAttempt(USER, RECORD_INPUT)
    expect(result.source).toBe('stored')
    expect(calls.map((call) => call.fn)).toEqual(['record_attempt', 'attempt_result'])
    expect(logs).toEqual([{ event: 'attempt_rpc_shape', fn: 'record_attempt' }])
  })

  it('attempt_result is null for an empty answer (a pending or foreign attempt)', async () => {
    const { rpc, calls } = harness({ attempt_result: [{ data: [], error: null, status: 200 }] })
    expect(await rpc.attemptResult(USER, ATTEMPT)).toBeNull()
    expect(calls[0]).toEqual({ fn: 'attempt_result', args: { p_user_id: USER, p_attempt_id: ATTEMPT } })
  })

  it('claim_lease is held only on a literal true (it returns NULL to everyone else)', async () => {
    const { rpc } = harness({
      claim_lease: [
        { data: true, error: null, status: 200 },
        { data: null, error: null, status: 200 },
      ],
    })
    expect(await rpc.claimLease('sweep', 60)).toBe(true)
    expect(await rpc.claimLease('sweep', 60)).toBe(false)
  })
})

describe('[R2-14] start_attempt retries', () => {
  it.each(['40P01', '40001'])('retries once on SQLSTATE %s', async (code) => {
    const { rpc, calls, logs } = harness({
      start_attempt: [pgError(code, 'deadlock detected', 500), { data: [START_ROW], error: null, status: 200 }],
    })
    expect((await rpc.startAttempt(START_INPUT)).attemptId).toBe(ATTEMPT)
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual(calls[0].args)
    expect(logs).toEqual([{ event: 'attempt_rpc_retry', fn: 'start_attempt', retry: 1, sqlstate: code, status: 500 }])
  })

  it('gives up after the one retry', async () => {
    const { rpc, calls } = harness({
      start_attempt: [pgError('40P01', 'deadlock', 500), pgError('40P01', 'deadlock', 500)],
    })
    await expect(rpc.startAttempt(START_INPUT)).rejects.toBeInstanceOf(RpcError)
    expect(calls).toHaveLength(2)
  })

  it('never retries a network error or a typed refusal, and keeps the hint for the error mapping', async () => {
    const hint = JSON.stringify({ pigEpoch: 4, level: 3 })
    const { rpc, calls } = harness({ start_attempt: [pgError('PT409', 'pig_changed', 409, hint)] })
    const error = await rpc.startAttempt(START_INPUT).catch((caught: unknown) => caught)
    expect(calls).toHaveLength(1)
    expect(mapRpcError(error).body).toEqual({
      error: expect.any(String),
      code: 'pig_changed',
      pigEpoch: 4,
      level: 3,
    })

    const network = harness({ start_attempt: [NETWORK] })
    await expect(network.rpc.startAttempt(START_INPUT)).rejects.toBeInstanceOf(RpcError)
    expect(network.calls).toHaveLength(1)
  })
})

describe('[R2-14] record_attempt retries', () => {
  it('retries up to 3 times with 100, 400, and 1,600 ms backoff on network errors and PostgREST 5xx', async () => {
    const { rpc, calls, sleeps, logs } = harness({
      record_attempt: [NETWORK, FIVE_HUNDRED, NETWORK, { data: [SETTLEMENT_ROW], error: null, status: 200 }],
    })
    expect((await rpc.recordAttempt(USER, RECORD_INPUT)).source).toBe('recorded')
    expect(calls).toHaveLength(4)
    expect(sleeps).toEqual([...RECORD_RETRY_DELAYS_MS])
    expect(sleeps).toEqual([100, 400, 1600])
    expect(logs).toEqual([
      { event: 'attempt_rpc_retry', fn: 'record_attempt', retry: 1, sqlstate: null, status: 0 },
      { event: 'attempt_rpc_retry', fn: 'record_attempt', retry: 2, sqlstate: 'PGRST000', status: 503 },
      { event: 'attempt_rpc_retry', fn: 'record_attempt', retry: 3, sqlstate: null, status: 0 },
    ])
  })

  it('throws after the third retry fails', async () => {
    const { rpc, calls } = harness({ record_attempt: [NETWORK, NETWORK, NETWORK, NETWORK] })
    await expect(rpc.recordAttempt(USER, RECORD_INPUT)).rejects.toBeInstanceOf(RpcError)
    expect(calls).toHaveLength(4)
  })

  it('treats PT409 already_finalized as success and reads the stored result back', async () => {
    const { rpc, calls } = harness({
      record_attempt: [NETWORK, pgError('PT409', 'already_finalized', 409)],
      attempt_result: [{ data: [STORED_ROW], error: null, status: 200 }],
    })
    const result = await rpc.recordAttempt(USER, RECORD_INPUT)
    expect(calls.map((call) => call.fn)).toEqual(['record_attempt', 'record_attempt', 'attempt_result'])
    expect(result).toEqual({
      source: 'stored',
      stored: expect.objectContaining({ outcome: 'win', payoutCents: 4200, walletBalanceCents: 6100, levelTo: 3 }),
    })
  })

  it.each([
    ['PT422', 'invariant_violation', 422],
    ['PT503', 'spend_cap', 503],
    ['22P05', 'unsupported Unicode escape sequence', 400],
  ])('does not retry %s', async (code, message, status) => {
    const { rpc, calls } = harness({ record_attempt: [pgError(code, message, status)] })
    await expect(rpc.recordAttempt(USER, RECORD_INPUT)).rejects.toBeInstanceOf(RpcError)
    expect(calls).toHaveLength(1)
  })

  it('[T25] retry logs carry no parameter, message, detail, or hint', async () => {
    const { rpc, logs } = harness({
      record_attempt: [pgError('40P01', 'deadlock while storing a reply', 500), { data: [SETTLEMENT_ROW], error: null, status: 200 }],
    })
    await rpc.recordAttempt(USER, RECORD_INPUT)
    const text = JSON.stringify(logs)
    for (const secret of ['REPLY-MARKER', 'PROMPT-MARKER', 'deadlock while', 'Failing row']) {
      expect(text).not.toContain(secret)
    }
  })
})

describe('error classification', () => {
  const error = (code: string | null, status: number | null) =>
    new RpcError('record_attempt', { code, message: '', details: '', hint: '', status })

  it('transient: no answer, a non-PT 5xx, or a lock conflict', () => {
    expect(isTransient(error(null, 0))).toBe(true)
    expect(isTransient(error(null, null))).toBe(true)
    expect(isTransient(error('PGRST000', 503))).toBe(true)
    expect(isTransient(error('40001', 500))).toBe(true)
    expect(isTransient(error('PT503', 503))).toBe(false)
    expect(isTransient(error('PT422', 422))).toBe(false)
    expect(isTransient(new Error('x'))).toBe(false)
  })

  it('[R3-07] unstorable: a data exception or a CHECK violation', () => {
    expect(isUnstorable(error('22P05', 400))).toBe(true)
    expect(isUnstorable(error('22021', 400))).toBe(true)
    expect(isUnstorable(error('23514', 400))).toBe(true)
    expect(isUnstorable(error('PT422', 422))).toBe(false)
    expect(isUnstorable(error(null, 0))).toBe(false)
  })

  it('a missing Supabase configuration surfaces as itself, so the route answers 503 unavailable', async () => {
    const client: RpcClient = {
      rpc: () => {
        throw new Error('Supabase admin client is not configured: set NEXT_PUBLIC_SUPABASE_URL.')
      },
    }
    const rpc = createAttemptRpc({ client, sleep: vi.fn(), log: vi.fn() })
    const caught = await rpc.startAttempt(START_INPUT).catch((value: unknown) => value)
    expect(mapRpcError(caught).body.code).toBe('unavailable')
  })
})

describe('source', () => {
  const source = stripComments(readFileSync(path.join(__dirname, 'rpc.ts'), 'utf8'))

  it('never reads the secret table or the crack count directly (R2-12, HC3)', () => {
    expect(source).not.toMatch(/level_secrets/)
    expect(source).not.toMatch(/crack_count/)
    expect(source).not.toMatch(/\.from\(/)
  })
})
