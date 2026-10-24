import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The attempt service against local Supabase (migrations 00001 to 00007),
 * with the fake Core model and the Decisions fake (docs/ARCHITECTURE.md
 * sections 3 and 5.4; HC3, HC-A5, CH-1; R2-05; T9, T13).
 *
 * It runs only when PP_LOCAL_SUPABASE=1 and the local stack's URL and secret
 * key are exported as NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY, for
 * example:
 *
 *   pnpm db:start && pnpm db:reset
 *   PP_LOCAL_SUPABASE=1 NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
 *     pnpm test -- src/app/api/attempts/attempts.integration.test.ts
 *
 * It refuses any URL that is not on localhost or 127.0.0.1, so it can never
 * touch a hosted project. Everywhere else it is skipped.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const enabled = process.env.PP_LOCAL_SUPABASE === '1' && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(url)

const LIMITS = {
  burst: 20,
  perMin: 60,
  perDay: 150,
  walletPerMin: 10,
  maxPromptChars: 2000,
  dailyCapMicros: 25_000_000,
  attemptShareBps: 8000,
  jobsPerHour: 30,
  jobsPerUserPerHour: 3,
  trafficWindow: 500,
  trafficMaxBps: 100,
}

describe.runIf(enabled)('the attempt service on local Supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const { createAttemptRunner } = await import('@/lib/ai/core/run-attempt')
  const { fakeDecide } = await import('@/lib/ai/testing/fake-decisions')
  const { FakeCoreModel } = await import('@/lib/ai/testing/fake-model')
  const { performAttempt } = await import('@/lib/game/attempt-service')
  const { createAttemptRpc } = await import('@/lib/game/rpc')
  type RpcClient = import('@/lib/game/rpc').RpcClient
  type RpcResponse = import('@/lib/game/rpc').RpcResponse

  // Created in beforeAll, which runs only when the suite is enabled.
  let admin: ReturnType<typeof createClient>
  const users: string[] = []

  beforeAll(async () => {
    admin = createClient(url, process.env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let index = 0; index < 2; index += 1) {
      const { data, error } = await admin.auth.admin.createUser({
        email: `pp26-${randomUUID()}@example.test`,
        password: randomUUID(),
        email_confirm: true,
      })
      if (error || !data.user) throw new Error(`createUser failed: ${error?.code ?? 'no user'}`)
      users.push(data.user.id)
    }
  })

  afterAll(async () => {
    for (const id of users) await admin.auth.admin.deleteUser(id)
    vi.restoreAllMocks()
  })

  async function epoch(): Promise<number> {
    const { data, error } = await admin.from('game_state').select('pig_epoch').eq('id', 1).single()
    if (error) throw new Error(`game_state read failed: ${error.code}`)
    return (data as { pig_epoch: number }).pig_epoch
  }

  function harness() {
    const models: InstanceType<typeof FakeCoreModel>[] = []
    const recorded: RpcResponse[] = []
    const client: RpcClient = {
      async rpc(fn, args) {
        const response = (await admin.rpc(fn as never, args as never)) as unknown as RpcResponse
        if (fn === 'record_attempt') recorded.push(response)
        return response
      },
    }
    const deps = {
      rpc: createAttemptRpc({ client }),
      runAttempt: createAttemptRunner({
        createModel: () => {
          const model = new FakeCoreModel()
          models.push(model)
          return model
        },
        decide: async (text: string) => fakeDecide(text),
        settings: { model: 'gpt-6-luna', maxOutputTokens: 1024, reasoningEffort: 'minimal' as const },
        log: () => {},
      }),
      hooks: { onPaidWin: async () => {}, maybeSweep: async () => {} },
      limits: LIMITS,
      log: () => {},
    }
    return { models, recorded, deps }
  }

  it('[HC3][HC-A5] two attempts by one user: each model input holds only its own message, and the DTO is record_attempt’s row', async () => {
    const h = harness()
    const userId = users[0]
    const messages = ['INTEGRATION-FIRST hello Penny', 'INTEGRATION-SECOND hello Penny']
    for (const [index, message] of messages.entries()) {
      const result = await performAttempt(
        { userId, message, idempotencyKey: randomUUID(), expectedEpoch: await epoch() },
        h.deps
      )
      if (result.kind !== 'ok') throw new Error(`attempt failed: ${result.mapping.body.code}`)
      const modelCall = h.models[index].calls
      expect(modelCall).toHaveLength(1)
      const serialized = JSON.stringify(modelCall[0].input)
      expect(serialized).toContain(index === 0 ? 'INTEGRATION-FIRST' : 'INTEGRATION-SECOND')
      expect(serialized).not.toContain(index === 0 ? 'INTEGRATION-SECOND' : 'INTEGRATION-FIRST')

      const row = (h.recorded[index].data as Record<string, unknown>[])[0]
      const dto = result.attempt
      expect({
        cracks: dto.cracks,
        crackEvent: dto.crackEvent,
        payoutCents: dto.payoutCents,
        refundCents: dto.refundCents,
        refundWithheld: dto.refundWithheld,
        walletBalanceCents: dto.walletBalanceCents,
        auraBps: dto.auraBps,
        game: dto.game,
      }).toEqual({
        cracks: row.cracks_after,
        crackEvent: row.crack_event,
        payoutCents: row.payout_cents,
        refundCents: row.refund_cents,
        refundWithheld: row.refund_withheld,
        walletBalanceCents: row.wallet_balance_cents,
        auraBps: row.aura_bps,
        game: { treasuryCents: row.treasury_cents, level: row.current_level, pigEpoch: row.pig_epoch },
      })
      expect(dto).toMatchObject({ outcome: 'fail', priceCents: 100, cracks: index + 1 })
    }
  })

  it('[R2-05] a re-POST of the same key returns the stored DTO without a model call or a second fee', async () => {
    const h = harness()
    const command = { userId: users[1], message: 'INTEGRATION-REPLAY hello', idempotencyKey: randomUUID(), expectedEpoch: await epoch() }
    const first = await performAttempt(command, h.deps)
    const second = await performAttempt({ ...command, expectedEpoch: 0 }, h.deps)
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('attempt failed')
    expect(second.attempt).toEqual(first.attempt)
    expect(h.models).toHaveLength(1)
    expect(h.recorded).toHaveLength(1)
    expect(first.attempt.walletBalanceCents).toBe(1900)
  })

  it('[CH-1] a system error refunds the price within the budget', async () => {
    const h = harness()
    const result = await performAttempt(
      { userId: users[1], message: 'INTEGRATION E2E_UPSTREAM_500', idempotencyKey: randomUUID(), expectedEpoch: await epoch() },
      h.deps
    )
    if (result.kind !== 'ok') throw new Error(`attempt failed: ${result.mapping.body.code}`)
    expect(result.attempt).toMatchObject({ outcome: 'error', refundCents: 100, refundWithheld: false, walletBalanceCents: 1900 })
  })

  it('[R2-20] a stale epoch is pig_changed and charges nothing', async () => {
    const h = harness()
    const current = await epoch()
    const result = await performAttempt(
      { userId: users[1], message: 'INTEGRATION stale', idempotencyKey: randomUUID(), expectedEpoch: current + 1000 },
      h.deps
    )
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.mapping.body).toMatchObject({ code: 'pig_changed', pigEpoch: current })
    expect(h.models).toHaveLength(0)
  })
})
