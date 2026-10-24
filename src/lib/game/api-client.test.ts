import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, type ApiError, type AttemptResultDTO, type ErrorCode } from '@/types/api'
import {
  ATTEMPTS_URL,
  DONATE_URL,
  REPAIR_URL,
  RETRY_DELAYS_MS,
  donate,
  errorMessage,
  outcomeMessage,
  postAttempt,
  repair,
  type ApiClientDeps,
} from './api-client'

/**
 * The idempotent browser client (docs/ARCHITECTURE.md section 7; R2-05,
 * R2-20, R2-S3, R2-01). fetch, sleep, the clock, and the key generator are
 * injected, so the backoff runs instantly and every request is inspectable.
 */

const KEY = '44444444-4444-4444-8444-444444444444'

const ATTEMPT: AttemptResultDTO = {
  id: 'a1',
  level: 1,
  outcome: 'fail',
  reply: 'Oink. No.',
  technique: 'roleplay_persona',
  cracks: 1,
  crackEvent: 'crack',
  priceCents: 100,
  payoutCents: 0,
  refundCents: 0,
  refundWithheld: false,
  walletBalanceCents: 1900,
  auraBps: 0,
  game: { treasuryCents: 4200, level: 1, pigEpoch: 3 },
  levelAdvanced: null,
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

type Step = Response | Error

function harness(steps: Step[]) {
  const queue = [...steps]
  const fetchMock = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
    void args
    const next = queue.shift()
    if (!next) throw new Error('unexpected extra request')
    if (next instanceof Error) throw next
    return next
  })
  let clock = 0
  const sleeps: number[] = []
  const deps: ApiClientDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    randomUUID: vi.fn(() => KEY),
  }
  const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))
  return { deps, fetchMock, sleeps, bodies, urls, advance: (ms: number) => (clock += ms) }
}

describe('postAttempt', () => {
  it('posts message, one generated key, and expectedEpoch, and parses the DTO', async () => {
    const h = harness([json(200, { attempt: ATTEMPT })])
    const result = await postAttempt({ message: 'hello pig', expectedEpoch: 3 }, h.deps)
    expect(result).toEqual({ kind: 'ok', attempt: ATTEMPT, idempotencyKey: KEY })
    expect(h.urls()).toEqual([ATTEMPTS_URL])
    expect(h.bodies()).toEqual([{ message: 'hello pig', idempotencyKey: KEY, expectedEpoch: 3 }])
    expect(h.deps.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('uses crypto.randomUUID by default', async () => {
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(KEY)
    const h = harness([json(200, { attempt: ATTEMPT })])
    await postAttempt({ message: 'x', expectedEpoch: 1 }, { ...h.deps, randomUUID: undefined })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(h.bodies()[0].idempotencyKey).toBe(KEY)
    spy.mockRestore()
  })

  it('recovers a dropped first response by re-posting the same key (R2-05)', async () => {
    const h = harness([new TypeError('Failed to fetch'), json(200, { attempt: ATTEMPT })])
    const result = await postAttempt({ message: 'hello pig', expectedEpoch: 3 }, h.deps)
    expect(result.kind).toBe('ok')
    expect(h.fetchMock).toHaveBeenCalledTimes(2)
    const [first, second] = h.bodies()
    expect(second).toEqual(first)
    expect(second.idempotencyKey).toBe(KEY)
    expect(h.deps.randomUUID).toHaveBeenCalledTimes(1)
    expect(h.sleeps).toEqual([1_000])
  })

  it('re-posts the same key on 409 attempt_in_flight with sameKey true until the stored DTO arrives', async () => {
    const inFlight = json(409, { error: 'This attack is still running.', code: 'attempt_in_flight', sameKey: true, retryAfterSeconds: 2 }, { 'retry-after': '2' })
    const h = harness([new TypeError('offline'), inFlight, json(409, { error: 'x', code: 'attempt_in_flight', sameKey: true, retryAfterSeconds: 1 }), json(200, { attempt: ATTEMPT })])
    const result = await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)
    expect(result.kind).toBe('ok')
    expect(new Set(h.bodies().map((b) => b.idempotencyKey))).toEqual(new Set([KEY]))
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000])
  })

  it('retries a gateway 504 without a JSON body with the same key', async () => {
    const h = harness([new Response('<html>timeout</html>', { status: 504 }), json(200, { attempt: ATTEMPT })])
    const result = await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)
    expect(result.kind).toBe('ok')
    expect(h.bodies()[0]).toEqual(h.bodies()[1])
  })

  it('backs off 1, 2, 4, 8, and 16 seconds and then gives up', async () => {
    const h = harness(Array.from({ length: 6 }, () => new TypeError('offline')))
    const result = await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)
    expect(result).toEqual({ kind: 'unreachable', idempotencyKey: KEY })
    expect(h.sleeps).toEqual([...RETRY_DELAYS_MS])
    expect(h.fetchMock).toHaveBeenCalledTimes(6)
  })

  it('stops after about 45 seconds even when requests are slow', async () => {
    const h = harness([])
    let calls = 0
    h.fetchMock.mockImplementation(async () => {
      calls++
      h.advance(10_000) // each lost request takes 10 s
      throw new TypeError('offline')
    })
    const result = await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)
    expect(result.kind).toBe('unreachable')
    expect(calls).toBeLessThan(6)
  })

  it('returns attempt_in_flight with sameKey false at once, with retryAfterSeconds', async () => {
    const body = { error: 'Another attack from your account is still running.', code: 'attempt_in_flight', sameKey: false, retryAfterSeconds: 9 }
    const h = harness([json(409, body, { 'retry-after': '9' })])
    const result = await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)
    expect(result).toMatchObject({ kind: 'error', status: 409, error: body, retryAfterSeconds: 9 })
    expect(h.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns pig_changed with the epoch and level to adopt (R2-20)', async () => {
    const body = { error: 'The pig just leveled up! Review your attack and send again.', code: 'pig_changed', pigEpoch: 8, level: 2 }
    const h = harness([json(409, body)])
    const result = await postAttempt({ message: 'm', expectedEpoch: 7 }, h.deps)
    expect(result).toMatchObject({ kind: 'error', error: body })
    expect(h.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads Retry-After for a 429', async () => {
    const h = harness([json(429, { error: 'Slow down', code: 'rate_limited' }, { 'retry-after': '12' })])
    const result = await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)
    expect(result).toMatchObject({ kind: 'error', status: 429, retryAfterSeconds: 12 })
  })

  it('reports not_open for a 404, before the attempt route exists', async () => {
    const h = harness([new Response('<html>404</html>', { status: 404 })])
    expect(await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)).toEqual({ kind: 'not_open', idempotencyKey: KEY })
  })

  it('never passes a malformed success body to the UI', async () => {
    const h = harness([json(200, { attempt: { ...ATTEMPT, cracks: 7 } })])
    const result = await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)
    expect(result).toMatchObject({ kind: 'error', error: { code: 'internal' } })
  })

  it('treats an unparseable 4xx error body as internal', async () => {
    const h = harness([json(400, { nope: true })])
    expect(await postAttempt({ message: 'm', expectedEpoch: 1 }, h.deps)).toMatchObject({ kind: 'error', status: 400, error: { code: 'internal' } })
  })
})

describe('repair and donate', () => {
  it('repair posts only the caller key and re-posts it after a lost response', async () => {
    const dto = { cracks: 0, walletBalanceCents: 1800, auraBps: 0, treasuryCents: 4300 }
    const h = harness([new TypeError('offline'), json(200, dto)])
    expect(await repair(KEY, h.deps)).toEqual({ kind: 'ok', result: dto })
    expect(h.urls()).toEqual([REPAIR_URL, REPAIR_URL])
    expect(h.bodies()).toEqual([{ idempotencyKey: KEY }, { idempotencyKey: KEY }])
  })

  it('repair returns nothing_to_repair as an error', async () => {
    const h = harness([json(409, { error: 'Your glass has no cracks to repair.', code: 'nothing_to_repair' })])
    expect(await repair(KEY, h.deps)).toMatchObject({ kind: 'error', status: 409, error: { code: 'nothing_to_repair' } })
  })

  it('donate posts the amount and key and re-posts the same pair after a lost response', async () => {
    const dto = { walletBalanceCents: 1500, totalDonatedCents: 500, auraBps: 2500 }
    const h = harness([new TypeError('offline'), json(200, dto)])
    expect(await donate(500, KEY, h.deps)).toEqual({ kind: 'ok', result: dto })
    expect(h.urls()).toEqual([DONATE_URL, DONATE_URL])
    expect(h.bodies()).toEqual([{ amountCents: 500, idempotencyKey: KEY }, { amountCents: 500, idempotencyKey: KEY }])
  })

  it('donate returns a 402 with the server message', async () => {
    const body = { error: 'You need $5.00 to donate. Your wallet has $1.00.', code: 'insufficient_funds' }
    const h = harness([json(402, body)])
    const result = await donate(500, KEY, h.deps)
    expect(result).toMatchObject({ kind: 'error', status: 402, error: body })
  })

  it('wallet calls give up after the backoff', async () => {
    const h = harness(Array.from({ length: 6 }, () => new TypeError('offline')))
    expect(await repair(KEY, h.deps)).toEqual({ kind: 'unreachable' })
    expect(h.sleeps).toEqual([...RETRY_DELAYS_MS])
  })
})

describe('errorMessage', () => {
  function errorFor(code: ErrorCode): ApiError {
    if (code === 'pig_changed') return { error: 'x', code, pigEpoch: 2, level: 2 }
    if (code === 'attempt_in_flight') return { error: 'x', code, sameKey: false, retryAfterSeconds: 3 }
    return { error: `server says ${code}`, code }
  }

  it.each([...ERROR_CODES])('has toast text for %s', (code) => {
    const text = errorMessage({ error: errorFor(code), retryAfterSeconds: null })
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(5)
  })

  it('429 shows the Retry-After seconds', () => {
    expect(errorMessage({ error: { error: 'x', code: 'rate_limited' }, retryAfterSeconds: 7 })).toContain('7 seconds')
  })

  it.each(['kill_switch', 'spend_cap_reached', 'unavailable'] as const)('503 %s shows Vault closed', (code) => {
    expect(errorMessage({ error: { error: 'x', code }, retryAfterSeconds: null })).toMatch(/^Vault closed/)
  })

  it('503 level_not_configured says the level is not ready', () => {
    expect(errorMessage({ error: { error: 'x', code: 'level_not_configured' }, retryAfterSeconds: null })).toBe('This level is not ready yet.')
  })

  it('402 shows the server message with the balance and the price', () => {
    const error: ApiError = { error: 'You need $1.00 to attack. Your wallet has $0.40.', code: 'insufficient_funds' }
    expect(errorMessage({ error, retryAfterSeconds: null })).toBe(error.error)
  })

  it('attempt_in_flight with sameKey false names the other attack', () => {
    const error: ApiError = { error: 'x', code: 'attempt_in_flight', sameKey: false, retryAfterSeconds: 4 }
    expect(errorMessage({ error, retryAfterSeconds: 4 })).toBe('Another attack from your account is still running.')
  })
})

describe('outcomeMessage', () => {
  it('explains a withheld refund (R2-01)', () => {
    expect(outcomeMessage({ ...ATTEMPT, outcome: 'error', refundWithheld: true, refundCents: 0 })).toBe(
      'A system error ended this attack. You reached the refund limit for this hour, so the $1.00 was kept.'
    )
  })

  it('shows the refunded amount for a refunded error', () => {
    expect(outcomeMessage({ ...ATTEMPT, outcome: 'error', refundWithheld: false, refundCents: 100 })).toBe(
      'A system error ended this attack. $1.00 was refunded.'
    )
  })

  it('shows the server payout for a win', () => {
    expect(outcomeMessage({ ...ATTEMPT, outcome: 'win', payoutCents: 4321 })).toContain('$43.21')
  })
})
