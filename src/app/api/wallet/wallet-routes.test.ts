import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DonateResultSchema, RepairResultSchema } from '@/types/api'

/**
 * POST /api/wallet/repair and POST /api/wallet/donate (docs/ARCHITECTURE.md
 * sections 7, 9.2, and 9.5; CH-1, CH-2, R2-16, T20; PR #6 review, M5). The
 * cookie-bound server client and the secret-key client are fakes. Each test
 * re-imports the routes so the cached server settings start empty.
 */
const getUser = vi.fn()
const rpc = vi.fn()
const createClient = vi.fn(async () => ({ auth: { getUser } }))
const createAdminClient = vi.fn(() => ({ rpc }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))
// require-user.ts imports redirect(), which only page helpers call.
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect is not used by API routes')
  },
}))

const APP = 'https://prompt-piggy.vercel.app'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'

function signedIn(overrides: Record<string, unknown> = {}) {
  getUser.mockResolvedValue({ data: { user: { id: USER_ID, is_anonymous: false, ...overrides } }, error: null })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  for (const name of ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'RATE_LIMIT_WALLET_PER_MIN']) vi.stubEnv(name, undefined)
  getUser.mockReset()
  rpc.mockReset()
  createClient.mockClear()
  createAdminClient.mockClear()
  signedIn()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

type Route = 'repair' | 'donate'

async function load(route: Route) {
  return route === 'repair' ? import('./repair/route') : import('./donate/route')
}

function post(route: Route, body: unknown, origin: string | null = APP): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== null) headers.set('origin', origin)
  return new NextRequest(`${APP}/api/wallet/${route}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function call(route: Route, body: unknown, origin?: string | null) {
  const response = await (await load(route)).POST(post(route, body, origin))
  return { response, json: await response.json() }
}

const REPAIR_BODY = { idempotencyKey: KEY }
const DONATE_BODY = { amountCents: 250, idempotencyKey: KEY }
const BODIES: Record<Route, unknown> = { repair: REPAIR_BODY, donate: DONATE_BODY }

function pgError(code: string, message: string, hint = '') {
  return { data: null, error: { code, message, details: '', hint } }
}

describe.each(['repair', 'donate'] as const)('POST /api/wallet/%s: shared guards', (route) => {
  it('declares the Node.js runtime and dynamic rendering', async () => {
    const mod = await load(route)
    expect(mod.runtime).toBe('nodejs')
    expect(mod.dynamic).toBe('force-dynamic')
  })

  it.each([
    ['another site', 'https://evil.example'],
    ['a look-alike host', 'https://prompt-piggy.vercel.app.evil.example'],
    ['Origin: null', 'null'],
    ['no Origin header', null],
  ])('answers 403 forbidden for a cross-origin POST from %s and never calls the RPC (T20)', async (_label, origin) => {
    const { response, json } = await call(route, BODIES[route], origin)
    expect(response.status).toBe(403)
    expect(json).toEqual({ error: 'You are not allowed to do that.', code: 'forbidden' })
    expect(createClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 401 for a signed-out caller', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    const { response, json } = await call(route, BODIES[route])
    expect(response.status).toBe(401)
    expect(json.code).toBe('unauthorized')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 401 for an anonymous user (R2-16)', async () => {
    signedIn({ is_anonymous: true })
    const { response } = await call(route, BODIES[route])
    expect(response.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', '{"idempotencyKey":'],
    ['a key that is not a uuid', { ...(BODIES[route] as object), idempotencyKey: 'nope' }],
    ['an unknown key (a price)', { ...(BODIES[route] as object), priceCents: 1 }],
    ['an unknown key (a user id)', { ...(BODIES[route] as object), userId: OTHER_ID }],
  ])('answers 400 invalid_request for %s', async (_label, body) => {
    const { response, json } = await call(route, body)
    expect(response.status).toBe(400)
    expect(json.code).toBe('invalid_request')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps an empty wallet bucket to 429 with Retry-After', async () => {
    rpc.mockResolvedValue(pgError('PT429', 'rate_limited: the wallet bucket is empty', '{"retryAfterSeconds": 7}'))
    const { response, json } = await call(route, BODIES[route])
    expect(response.status).toBe(429)
    expect(json.code).toBe('rate_limited')
    expect(response.headers.get('retry-after')).toBe('7')
  })

  it('answers 500 internal without SQL text for an unknown database error', async () => {
    rpc.mockResolvedValue(pgError('XX000', 'secret row value leaked here'))
    const { response, json } = await call(route, BODIES[route])
    expect(response.status).toBe(500)
    expect(JSON.stringify(json)).not.toContain('secret row value')
  })

  it('answers 503 unavailable when the secret-key client is not configured', async () => {
    createAdminClient.mockImplementationOnce(() => {
      throw new Error('Supabase admin client is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.')
    })
    const { response, json } = await call(route, BODIES[route])
    expect(response.status).toBe(503)
    expect(json.code).toBe('unavailable')
  })
})

describe('POST /api/wallet/repair', () => {
  it('calls repair_glass with the session user, the key, and the wallet rate limit, never a price', async () => {
    rpc.mockResolvedValue({
      data: [{ cracks: 0, wallet_balance_cents: 1700, aura_bps: 1200, treasury_cents: 4100, replay: false }],
      error: null,
    })
    const { response, json } = await call('repair', REPAIR_BODY)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('repair_glass', {
      p_user_id: USER_ID,
      p_idempotency_key: KEY,
      p_rate_capacity: 5,
      p_rate_refill_per_min: 10,
    })
    expect(JSON.stringify(rpc.mock.calls[0])).not.toMatch(/price/i)
    expect(json).toEqual({ cracks: 0, walletBalanceCents: 1700, auraBps: 1200, treasuryCents: 4100 })
    expect(RepairResultSchema.safeParse(json).success).toBe(true)
  })

  it('uses RATE_LIMIT_WALLET_PER_MIN for the refill', async () => {
    vi.stubEnv('RATE_LIMIT_WALLET_PER_MIN', '20')
    rpc.mockResolvedValue({ data: [{ cracks: 0, wallet_balance_cents: 1, aura_bps: 0, treasury_cents: 1, replay: false }], error: null })
    await call('repair', REPAIR_BODY)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_rate_refill_per_min: 20 })
  })

  it('maps nothing_to_repair to 409', async () => {
    rpc.mockResolvedValue(pgError('PT409', 'nothing_to_repair: the glass has no cracks'))
    const { response, json } = await call('repair', REPAIR_BODY)
    expect(response.status).toBe(409)
    expect(json).toEqual({ error: 'Your glass has no cracks to repair.', code: 'nothing_to_repair' })
  })

  it('maps insufficient_funds to 402 with the balance and the price', async () => {
    rpc.mockResolvedValue(
      pgError('PT402', 'insufficient_funds: the balance is lower than the repair price', '{"balanceCents": 40, "priceCents": 100}')
    )
    const { response, json } = await call('repair', REPAIR_BODY)
    expect(response.status).toBe(402)
    expect(json).toEqual({ error: 'You need $1.00 to repair. Your wallet has $0.40.', code: 'insufficient_funds' })
  })

  it('answers a replayed key whose glass cracked again with 409 already_finalized', async () => {
    rpc.mockResolvedValue({ data: [{ cracks: 1, wallet_balance_cents: 1600, aura_bps: 0, treasury_cents: 10, replay: true }], error: null })
    const { response, json } = await call('repair', REPAIR_BODY)
    expect(response.status).toBe(409)
    expect(json.code).toBe('already_finalized')
  })

  it('returns the stored state for a replayed key at 0 cracks', async () => {
    rpc.mockResolvedValue({ data: [{ cracks: 0, wallet_balance_cents: 1600, aura_bps: 0, treasury_cents: 10, replay: true }], error: null })
    const { response, json } = await call('repair', REPAIR_BODY)
    expect(response.status).toBe(200)
    expect(json).toEqual({ cracks: 0, walletBalanceCents: 1600, auraBps: 0, treasuryCents: 10 })
  })

  it('answers 500 when the RPC returns no row', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    expect((await call('repair', REPAIR_BODY)).response.status).toBe(500)
  })
})

describe('POST /api/wallet/donate', () => {
  it('calls donate with the session user, the requested amount, the key, and the wallet rate limit', async () => {
    rpc.mockResolvedValue({ data: [{ wallet_balance_cents: 1750, total_donated_cents: 250, aura_bps: 1250, replay: false }], error: null })
    const { response, json } = await call('donate', DONATE_BODY)
    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('donate', {
      p_user_id: USER_ID,
      p_amount_cents: 250,
      p_idempotency_key: KEY,
      p_rate_capacity: 5,
      p_rate_refill_per_min: 10,
    })
    expect(json).toEqual({ walletBalanceCents: 1750, totalDonatedCents: 250, auraBps: 1250 })
    expect(DonateResultSchema.safeParse(json).success).toBe(true)
  })

  it.each([
    ['zero', 0],
    ['a negative amount', -5],
    ['a fraction of a cent', 1.5],
    ['a string', '250'],
    ['a missing amount', undefined],
  ])('answers 400 for %s', async (_label, amountCents) => {
    const { response } = await call('donate', { idempotencyKey: KEY, amountCents })
    expect(response.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps invalid_amount to 422', async () => {
    rpc.mockResolvedValue(pgError('PT422', 'invalid_amount: a donation is at least 1 cent'))
    const { response, json } = await call('donate', DONATE_BODY)
    expect(response.status).toBe(422)
    expect(json.code).toBe('invalid_amount')
  })

  it('maps insufficient_funds to 402 with the balance and the amount', async () => {
    rpc.mockResolvedValue(
      pgError('PT402', 'insufficient_funds: the balance is lower than the donation', '{"balanceCents": 100, "priceCents": 250}')
    )
    const { response, json } = await call('donate', DONATE_BODY)
    expect(response.status).toBe(402)
    expect(json).toEqual({ error: 'You need $2.50 to donate. Your wallet has $1.00.', code: 'insufficient_funds' })
  })

  it('answers 500 when the RPC returns no row', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    expect((await call('donate', DONATE_BODY)).response.status).toBe(500)
  })
})
