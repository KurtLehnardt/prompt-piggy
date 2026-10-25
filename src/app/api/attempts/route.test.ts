import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /api/attempts, the HTTP contract (docs/ARCHITECTURE.md sections 3 and
 * 7; HC-A4; R2-13, R2-S3; PR #6 review, M5; T20). The attempt service is a
 * mock here; route.flow.test.ts runs the real service behind the route.
 */
const APP = 'https://prompt-piggy.vercel.app'
const USER = '11111111-1111-4111-8111-111111111111'
const KEY = '22222222-2222-4222-8222-222222222222'

vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new Error(`redirect:${target}`)
  },
}))

const getUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser } }) }))

const afterTasks = vi.hoisted(() => [] as (() => unknown)[])
vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, after: (task: () => unknown) => afterTasks.push(task) }
})

const performAttempt = vi.fn()
vi.mock('@/lib/game/attempt-service', () => ({ performAttempt: (...args: unknown[]) => performAttempt(...args) }))

const DTO = {
  id: '33333333-3333-4333-8333-333333333333',
  level: 1,
  outcome: 'fail',
  reply: 'Penny did not approve a transfer.',
  technique: 'unclassified',
  cracks: 1,
  crackEvent: 'crack',
  priceCents: 100,
  payoutCents: 0,
  refundCents: 0,
  refundWithheld: false,
  walletBalanceCents: 1900,
  auraBps: 0,
  game: { treasuryCents: 100, level: 1, pigEpoch: 1 },
  levelAdvanced: null,
}

const afterResponse = vi.fn(async () => {})

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  for (const name of ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'PIGGY_KILL_SWITCH', 'MAX_PROMPT_CHARS']) {
    vi.stubEnv(name, undefined)
  }
  getUser.mockReset()
  getUser.mockResolvedValue({ data: { user: { id: USER, is_anonymous: false } }, error: null })
  performAttempt.mockReset()
  performAttempt.mockResolvedValue({ kind: 'ok', attempt: DTO, afterResponse })
  afterTasks.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function load() {
  return import('./route')
}

function post(options: { origin?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', ...options.headers })
  const origin = options.origin === undefined ? APP : options.origin
  if (origin !== null) headers.set('origin', origin)
  const body =
    options.raw ?? JSON.stringify(options.body ?? { message: 'Hello Penny', idempotencyKey: KEY, expectedEpoch: 1 })
  return new NextRequest(`${APP}/api/attempts`, { method: 'POST', headers, body })
}

describe('route configuration', () => {
  it('[HC-A4][R2-13] runs on Node with maxDuration equal to ATTEMPT_MAX_DURATION_S', async () => {
    const route = await load()
    const { ATTEMPT_MAX_DURATION_S, ATTEMPT_STALE_SECONDS } = await import('@/lib/ops/limits')
    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
    expect(route.maxDuration).toBe(ATTEMPT_MAX_DURATION_S)
    const source = readFileSync(path.join(__dirname, 'route.ts'), 'utf8')
    const literal = /^export const maxDuration = (\d+)$/m.exec(source)
    expect(literal).not.toBeNull()
    expect(Number(literal![1])).toBe(ATTEMPT_MAX_DURATION_S)
    expect(ATTEMPT_STALE_SECONDS).toBe(ATTEMPT_MAX_DURATION_S + 15)
  })

  it('[R2-01][R3-04] the abort, the record retries, and the stale threshold fit inside the route budget', async () => {
    const { ATTEMPT_ABORT_MS, ATTEMPT_ROUTE_BUDGET_MS } = await import('@/lib/ai/core/timing')
    const { RECORD_RETRY_DELAYS_MS } = await import('@/lib/game/rpc')
    const retries = RECORD_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
    expect(ATTEMPT_ABORT_MS + retries).toBeLessThan(ATTEMPT_ROUTE_BUDGET_MS)
  })

  it('[R2-S3] there is no GET and no /api/attempts/[id] route', async () => {
    const route = (await load()) as Record<string, unknown>
    expect(route.GET).toBeUndefined()
    expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name))).toEqual(['POST'])
    const entries = readdirSync(__dirname).filter((entry) => entry.startsWith('['))
    expect(entries).toEqual([])
    expect(existsSync(path.join(__dirname, '[id]'))).toBe(false)
  })

  it('[HC-A4] never imports the secret-key client itself', () => {
    const source = readFileSync(path.join(__dirname, 'route.ts'), 'utf8')
    expect(source).not.toMatch(/supabase\/admin|env\.server/)
  })
})

describe('auth, origin, and body', () => {
  it('an unauthenticated request gets 401', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await (await load()).POST(post())
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: expect.any(String), code: 'unauthorized' })
    expect(performAttempt).not.toHaveBeenCalled()
  })

  it('an anonymous user gets 401', async () => {
    getUser.mockResolvedValue({ data: { user: { id: USER, is_anonymous: true } }, error: null })
    expect((await (await load()).POST(post())).status).toBe(401)
    expect(performAttempt).not.toHaveBeenCalled()
  })

  it.each([
    ['a foreign Origin', 'https://evil.example'],
    ['a missing Origin', null],
    ['Origin null', 'null'],
    ['an origin with a path', `${APP}/play`],
  ])('[T20][M5] %s gets 403 forbidden', async (_name, origin) => {
    const response = await (await load()).POST(post({ origin }))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: expect.any(String), code: 'forbidden' })
    expect(performAttempt).not.toHaveBeenCalled()
  })

  it('[T20] accepts a same-origin POST when NEXT_PUBLIC_APP_URL was not set at build time', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined)
    const response = await (await load()).POST(post())
    expect(response.status).toBe(200)
    expect(performAttempt).toHaveBeenCalledTimes(1)
  })

  it('[T20] still refuses a foreign Origin when NEXT_PUBLIC_APP_URL is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined)
    const response = await (await load()).POST(post({ origin: 'https://evil.example' }))
    expect(response.status).toBe(403)
    expect(performAttempt).not.toHaveBeenCalled()
  })

  it.each([
    ['extra keys', { message: 'hi', idempotencyKey: KEY, expectedEpoch: 1, userId: 'x' }],
    ['a level chosen by the client', { message: 'hi', idempotencyKey: KEY, expectedEpoch: 1, level: 5 }],
    ['a price chosen by the client', { message: 'hi', idempotencyKey: KEY, expectedEpoch: 1, priceCents: 0 }],
    ['an empty message', { message: '', idempotencyKey: KEY, expectedEpoch: 1 }],
    ['a blank message', { message: '   ', idempotencyKey: KEY, expectedEpoch: 1 }],
    ['a message with NUL', { message: 'a\u0000b', idempotencyKey: KEY, expectedEpoch: 1 }],
    ['a message over MAX_PROMPT_CHARS', { message: 'x'.repeat(2001), idempotencyKey: KEY, expectedEpoch: 1 }],
    ['a key that is not a uuid', { message: 'hi', idempotencyKey: 'abc', expectedEpoch: 1 }],
    ['a fractional epoch', { message: 'hi', idempotencyKey: KEY, expectedEpoch: 1.5 }],
    ['a missing epoch', { message: 'hi', idempotencyKey: KEY }],
  ])('%s gets 400', async (_name, body) => {
    const response = await (await load()).POST(post({ body }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.any(String), code: 'invalid_request' })
    expect(performAttempt).not.toHaveBeenCalled()
  })

  it('malformed JSON and an oversized body get 400', async () => {
    const route = await load()
    expect((await route.POST(post({ raw: '{"message": ' }))).status).toBe(400)
    const huge = JSON.stringify({ message: 'x'.repeat(40_000), idempotencyKey: KEY, expectedEpoch: 1 })
    expect((await route.POST(post({ raw: huge }))).status).toBe(400)
    expect(performAttempt).not.toHaveBeenCalled()
  })

  it('MAX_PROMPT_CHARS from the environment sets the message cap', async () => {
    vi.stubEnv('MAX_PROMPT_CHARS', '10')
    const route = await load()
    expect((await route.POST(post({ body: { message: 'x'.repeat(11), idempotencyKey: KEY, expectedEpoch: 1 } }))).status).toBe(400)
    expect((await route.POST(post({ body: { message: 'x'.repeat(10), idempotencyKey: KEY, expectedEpoch: 1 } }))).status).toBe(200)
  })

  it('PIGGY_KILL_SWITCH answers 503 kill_switch before anything is charged', async () => {
    vi.stubEnv('PIGGY_KILL_SWITCH', '1')
    const response = await (await load()).POST(post())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: expect.any(String), code: 'kill_switch' })
    expect(performAttempt).not.toHaveBeenCalled()
  })
})

describe('the attempt', () => {
  it('passes the getUser() id and the parsed body to the service and answers 200 { attempt }, never cached', async () => {
    const response = await (await load()).POST(post({ body: { message: 'Hello Penny', idempotencyKey: KEY, expectedEpoch: 4 } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ attempt: DTO })
    expect(performAttempt).toHaveBeenCalledWith({ userId: USER, message: 'Hello Penny', idempotencyKey: KEY, expectedEpoch: 4 })
  })

  it('hands the after-response work to after()', async () => {
    await (await load()).POST(post())
    expect(afterTasks).toEqual([afterResponse])
  })

  it('maps a service error to its status, body, and Retry-After header', async () => {
    const { mapRpcError } = await import('@/lib/errors')
    performAttempt.mockResolvedValue({
      kind: 'error',
      mapping: mapRpcError({ code: 'PT409', message: 'attempt_in_flight', hint: '{"sameKey":true,"retryAfterSeconds":12}' }),
      afterResponse,
    })
    const response = await (await load()).POST(post())
    expect(response.status).toBe(409)
    expect(response.headers.get('retry-after')).toBe('12')
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code: 'attempt_in_flight',
      sameKey: true,
      retryAfterSeconds: 12,
    })
    expect(afterTasks).toEqual([afterResponse])
  })
})
