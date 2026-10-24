import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampRetryAfterSeconds,
  ERROR_MESSAGES,
  ERROR_STATUS,
  errorResponse,
  jsonError,
  mapRpcError,
  parseAttemptInFlightHint,
  parseFundsHint,
  parsePigChangedHint,
  parseRetryHint,
  SAME_KEY_IN_FLIGHT_MESSAGE,
} from '@/lib/errors'
import { ApiErrorSchema, ERROR_CODES } from '@/types/api'

/**
 * errors.ts against every row of the docs/ARCHITECTURE.md section 7 error
 * table, plus each hint case (R1-23, R2-05, R2-20, R3-06, R3-14).
 */

/** A PostgREST error as supabase-js returns it. */
function pgError(code: string, message: string, hint: string | null = null, details: string | null = null) {
  return { name: 'PostgrestError', code, message, hint, details }
}

describe('ERROR_STATUS (the section 7 table)', () => {
  it('maps every code to its status', () => {
    expect(ERROR_STATUS).toEqual({
      invalid_request: 400,
      unauthorized: 401,
      insufficient_funds: 402,
      forbidden: 403,
      not_found: 404,
      attempt_in_flight: 409,
      already_finalized: 409,
      pig_changed: 409,
      nothing_to_repair: 409,
      stale_parent: 409,
      invalid_amount: 422,
      invariant_violation: 422,
      rate_limited: 429,
      daily_cap: 429,
      kill_switch: 503,
      spend_cap_reached: 503,
      level_not_configured: 503,
      unavailable: 503,
      internal: 500,
    })
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort())
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ERROR_CODES].sort())
  })

  it('includes level_not_configured and unavailable as 503 (R2-12, R3-14)', () => {
    expect(ERROR_STATUS.level_not_configured).toBe(503)
    expect(ERROR_STATUS.unavailable).toBe(503)
  })
})

describe('jsonError', () => {
  it('returns { error, code } with the status and no-store', async () => {
    const response = jsonError('forbidden', 403)
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('retry-after')).toBeNull()
    expect(await response.json()).toEqual({ error: ERROR_MESSAGES.forbidden, code: 'forbidden' })
  })

  it('uses a custom message', async () => {
    const response = jsonError('invalid_request', 400, 'The message is too long.')
    expect(await response.json()).toEqual({ error: 'The message is too long.', code: 'invalid_request' })
  })

  it('sets Retry-After for a rate limit, rounded up and clamped', async () => {
    const response = jsonError('rate_limited', 429, undefined, { retryAfterSeconds: 7.2 })
    expect(response.headers.get('retry-after')).toBe('8')
    expect(await response.json()).toEqual({ error: ERROR_MESSAGES.rate_limited, code: 'rate_limited' })
    expect(jsonError('daily_cap', 429, undefined, { retryAfterSeconds: 0 }).headers.get('retry-after')).toBe('1')
  })

  it('pig_changed carries pigEpoch and level (R2-20)', async () => {
    const response = jsonError('pig_changed', 409, undefined, { pigEpoch: 7, level: 3 })
    const body = await response.json()
    expect(body).toEqual({ error: ERROR_MESSAGES.pig_changed, code: 'pig_changed', pigEpoch: 7, level: 3 })
    expect(ApiErrorSchema.parse(body)).toEqual(body)
  })

  it('attempt_in_flight carries sameKey and retryAfterSeconds of at least 1 (R2-05, R3-06)', async () => {
    const response = jsonError('attempt_in_flight', 409, undefined, { sameKey: true, retryAfterSeconds: -4 })
    const body = await response.json()
    expect(body).toEqual({
      error: ERROR_MESSAGES.attempt_in_flight,
      code: 'attempt_in_flight',
      sameKey: true,
      retryAfterSeconds: 1,
    })
    expect(response.headers.get('retry-after')).toBe('1')
    expect(ApiErrorSchema.parse(body)).toEqual(body)
  })

  it('every plain code produces a body that ApiErrorSchema accepts', async () => {
    for (const code of ERROR_CODES) {
      if (code === 'pig_changed' || code === 'attempt_in_flight') continue
      const body = await jsonError(code, ERROR_STATUS[code]).json()
      expect(ApiErrorSchema.safeParse(body).success, code).toBe(true)
    }
  })
})

describe('mapRpcError: every row of the table', () => {
  it.each([
    ['PT402', 'insufficient_funds', 402, 'insufficient_funds'],
    ['PT403', 'forbidden', 403, 'forbidden'],
    ['PT403', 'ledger_entries is append-only', 403, 'forbidden'],
    ['PT409', 'already_finalized', 409, 'already_finalized'],
    ['PT409', 'nothing_to_repair', 409, 'nothing_to_repair'],
    ['PT409', 'stale_parent', 409, 'stale_parent'],
    ['PT409', 'pig_changed', 409, 'pig_changed'],
    ['PT409', 'attempt_in_flight', 409, 'attempt_in_flight'],
    ['PT422', 'invalid_amount', 422, 'invalid_amount'],
    ['PT422', 'invariant_violation', 422, 'invariant_violation'],
    ['PT422', 'not_a_win', 422, 'invariant_violation'],
    ['PT422', 'promote_rule_set: candidate weakens parent', 422, 'invariant_violation'],
    ['PT429', 'rate_limited', 429, 'rate_limited'],
    ['PT429', 'daily_cap', 429, 'daily_cap'],
    ['PT503', 'kill_switch', 503, 'kill_switch'],
    ['PT503', 'spend_cap', 503, 'spend_cap_reached'],
    ['PT503', 'spend_cap_reached', 503, 'spend_cap_reached'],
    ['PT503', 'level_not_configured', 503, 'level_not_configured'],
    ['PT503', 'something new', 503, 'unavailable'],
  ])('%s %s -> %s %s', (sqlstate, message, status, code) => {
    const mapping = mapRpcError(pgError(sqlstate, message))
    expect(mapping.status).toBe(status)
    expect(mapping.body.code).toBe(code)
    expect(ApiErrorSchema.safeParse(mapping.body).success).toBe(true)
  })

  it('finds the token inside a longer message', () => {
    expect(mapRpcError(pgError('PT409', 'start_attempt: pig_changed')).body.code).toBe('pig_changed')
    expect(mapRpcError(pgError('PT409', 'PT409 already_finalized')).body.code).toBe('already_finalized')
  })

  it('an unknown PT409 token is internal, logged, and leaks nothing', () => {
    const mapping = mapRpcError(pgError('PT409', 'secret detail about row 42'))
    expect(mapping.status).toBe(500)
    expect(mapping.body).toEqual({ error: ERROR_MESSAGES.internal, code: 'internal' })
    expect(mapping.log).toBe(true)
    expect(mapping.logContext).toEqual({ sqlstate: 'PT409', token: null })
  })

  it('logs server bugs only', () => {
    expect(mapRpcError(pgError('PT422', 'invariant_violation')).log).toBe(true)
    expect(mapRpcError(pgError('XX000', 'boom')).log).toBe(true)
    expect(mapRpcError(pgError('PT402', 'insufficient_funds')).log).toBe(false)
    expect(mapRpcError(pgError('PT429', 'rate_limited', '3')).log).toBe(false)
  })

  it('a 23505 on attempts (user_id, idempotency_key) is attempt_in_flight with sameKey true', () => {
    const byName = mapRpcError(
      pgError('23505', 'duplicate key value violates unique constraint "attempts_user_idempotency_key"')
    )
    expect(byName.status).toBe(409)
    expect(byName.body).toEqual({
      error: SAME_KEY_IN_FLIGHT_MESSAGE,
      code: 'attempt_in_flight',
      sameKey: true,
      retryAfterSeconds: 1,
    })
    expect(byName.retryAfterSeconds).toBe(1)

    const byDetails = mapRpcError(
      pgError('23505', 'duplicate key value', null, 'Key (user_id, idempotency_key)=(a, b) already exists.')
    )
    expect(byDetails.body.code).toBe('attempt_in_flight')
  })

  it('any other 23505 is internal', () => {
    const mapping = mapRpcError(
      pgError('23505', 'duplicate key value violates unique constraint "attempts_one_win_per_epoch"')
    )
    expect(mapping.body.code).toBe('internal')
    expect(mapping.status).toBe(500)
  })

  it.each([
    ['a PostgREST error', pgError('PGRST202', 'Could not find the function public.start_attempt')],
    ['a deadlock after retries', pgError('40P01', 'deadlock detected')],
    ['a network failure', new TypeError('fetch failed')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('%s is 500 internal with no internals in the message', (_label, error) => {
    const mapping = mapRpcError(error)
    expect(mapping.status).toBe(500)
    expect(mapping.body).toEqual({ error: ERROR_MESSAGES.internal, code: 'internal' })
  })

  it('never copies the database message, details, or hint into the body', () => {
    const leak = 'Failing row contains (secret prompt text)'
    for (const sqlstate of ['PT402', 'PT403', 'PT409', 'PT422', 'PT429', 'PT503', '23505', '23514', 'XX000']) {
      const mapping = mapRpcError(pgError(sqlstate, `pig_changed ${leak}`, leak, leak))
      expect(JSON.stringify(mapping.body)).not.toContain('secret prompt')
      expect(JSON.stringify(mapping.logContext)).not.toContain('secret prompt')
    }
  })
})

describe('mapRpcError: hints', () => {
  it('pig_changed adopts the hint epoch and level (R2-20)', () => {
    const mapping = mapRpcError(pgError('PT409', 'pig_changed', '{"pigEpoch":12,"level":4}'))
    expect(mapping.body).toEqual({ error: ERROR_MESSAGES.pig_changed, code: 'pig_changed', pigEpoch: 12, level: 4 })
  })

  it.each([
    ['no hint', null],
    ['an empty hint', ''],
    ['not JSON', 'epoch 12'],
    ['an array', '[12, 4]'],
    ['a level out of range', '{"pigEpoch":12,"level":6}'],
    ['a fractional epoch', '{"pigEpoch":1.5,"level":2}'],
    ['epoch 0', '{"pigEpoch":0,"level":2}'],
    ['a string epoch', '{"pigEpoch":"12","level":2}'],
    ['a missing level', '{"pigEpoch":12}'],
  ])('pig_changed with %s falls back to epoch 0 ("refetch") and level 1', (_label, hint) => {
    const mapping = mapRpcError(pgError('PT409', 'pig_changed', hint))
    expect(mapping.body).toMatchObject({ code: 'pig_changed', pigEpoch: 0, level: 1 })
    expect(ApiErrorSchema.safeParse(mapping.body).success).toBe(true)
  })

  it('attempt_in_flight adopts the hint (R2-05)', () => {
    const sameKey = mapRpcError(pgError('PT409', 'attempt_in_flight', '{"sameKey":true,"retryAfterSeconds":12.1}'))
    expect(sameKey.body).toEqual({
      error: SAME_KEY_IN_FLIGHT_MESSAGE,
      code: 'attempt_in_flight',
      sameKey: true,
      retryAfterSeconds: 13,
    })
    expect(sameKey.retryAfterSeconds).toBe(13)

    const other = mapRpcError(pgError('PT409', 'attempt_in_flight', '{"sameKey":false,"retryAfterSeconds":30}'))
    expect(other.body).toEqual({
      error: ERROR_MESSAGES.attempt_in_flight,
      code: 'attempt_in_flight',
      sameKey: false,
      retryAfterSeconds: 30,
    })
  })

  it('attempt_in_flight clamps a stale or huge retryAfterSeconds to 1..300 (R3-06)', () => {
    expect(parseAttemptInFlightHint('{"sameKey":true,"retryAfterSeconds":-3}')).toEqual({ sameKey: true, retryAfterSeconds: 1 })
    expect(parseAttemptInFlightHint('{"sameKey":true,"retryAfterSeconds":0}')).toEqual({ sameKey: true, retryAfterSeconds: 1 })
    expect(parseAttemptInFlightHint('{"sameKey":false,"retryAfterSeconds":9999}')).toEqual({ sameKey: false, retryAfterSeconds: 300 })
    expect(parseAttemptInFlightHint('{"sameKey":true,"retryAfterSeconds":"soon"}')).toEqual({ sameKey: true, retryAfterSeconds: 5 })
  })

  it.each([null, '', 'nope', '{"retryAfterSeconds":3}', '{"sameKey":"yes","retryAfterSeconds":3}'])(
    'attempt_in_flight with the malformed hint %j falls back to sameKey false and 5 seconds',
    (hint) => {
      const mapping = mapRpcError(pgError('PT409', 'attempt_in_flight', hint))
      expect(mapping.body).toMatchObject({ code: 'attempt_in_flight', sameKey: false, retryAfterSeconds: 5 })
      expect(ApiErrorSchema.safeParse(mapping.body).success).toBe(true)
    }
  )

  it('insufficient_funds states the balance and the price (section 7)', () => {
    const attack = mapRpcError(pgError('PT402', 'insufficient_funds', '{"balanceCents":40,"priceCents":100}'), {
      action: 'attack',
    })
    expect(attack.body).toEqual({
      error: 'You need $1.00 to attack. Your wallet has $0.40.',
      code: 'insufficient_funds',
    })
    const repair = mapRpcError(pgError('PT402', 'insufficient_funds', '{"balance_cents":50,"price_cents":100}'), {
      action: 'repair',
    })
    expect(repair.body.error).toBe('You need $1.00 to repair. Your wallet has $0.50.')
    const plain = mapRpcError(pgError('PT402', 'insufficient_funds', '{"balanceCents":0,"priceCents":500}'))
    expect(plain.body.error).toBe('You need $5.00. Your wallet has $0.00.')
  })

  it.each([null, 'nope', '{"balanceCents":1.5,"priceCents":100}', '{"balanceCents":40}', '{"balanceCents":40,"priceCents":0}'])(
    'insufficient_funds with the malformed hint %j uses the default message',
    (hint) => {
      expect(mapRpcError(pgError('PT402', 'insufficient_funds', hint)).body).toEqual({
        error: ERROR_MESSAGES.insufficient_funds,
        code: 'insufficient_funds',
      })
    }
  )

  it('rate_limited takes Retry-After from a numeric or JSON hint', () => {
    expect(mapRpcError(pgError('PT429', 'rate_limited', '7')).retryAfterSeconds).toBe(7)
    expect(mapRpcError(pgError('PT429', 'rate_limited', '2.3')).retryAfterSeconds).toBe(3)
    expect(mapRpcError(pgError('PT429', 'rate_limited', '{"retryAfterSeconds":4}')).retryAfterSeconds).toBe(4)
    expect(mapRpcError(pgError('PT429', 'rate_limited', 'soon')).retryAfterSeconds).toBe(10)
    expect(mapRpcError(pgError('PT429', 'rate_limited')).retryAfterSeconds).toBe(10)
  })

  it('daily_cap defaults Retry-After to the next UTC midnight', () => {
    const now = new Date('2026-10-24T23:59:00.000Z')
    expect(mapRpcError(pgError('PT429', 'daily_cap'), { now }).retryAfterSeconds).toBe(60)
    expect(mapRpcError(pgError('PT429', 'daily_cap', '120'), { now }).retryAfterSeconds).toBe(120)
  })

  it('an unknown PT429 token is rate_limited', () => {
    expect(mapRpcError(pgError('PT429', 'slow down')).body.code).toBe('rate_limited')
  })

  it('the hint parsers never throw', () => {
    for (const hint of ['', '{', 'null', '[]', '"x"', '{"a":{"b":1}}', '1e999']) {
      expect(() => parsePigChangedHint(hint)).not.toThrow()
      expect(() => parseAttemptInFlightHint(hint)).not.toThrow()
      expect(() => parseFundsHint(hint)).not.toThrow()
      expect(() => parseRetryHint(hint)).not.toThrow()
    }
    expect(parseRetryHint('1e999')).toBeNull()
    expect(clampRetryAfterSeconds(Number.NaN)).toBe(1)
    expect(clampRetryAfterSeconds(1e9)).toBe(86_400)
  })
})

describe('mapRpcError: a missing environment is 503 unavailable (R3-14)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('maps the Supabase client errors thrown with an empty environment', async () => {
    for (const name of [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]) {
      vi.stubEnv(name, undefined)
    }
    vi.resetModules()
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { createAnonClient } = await import('@/lib/supabase/anon')
    for (const factory of [createAdminClient, createAnonClient]) {
      let caught: unknown
      try {
        factory()
      } catch (error) {
        caught = error
      }
      const mapping = mapRpcError(caught)
      expect(mapping.status).toBe(503)
      expect(mapping.body).toEqual({ error: ERROR_MESSAGES.unavailable, code: 'unavailable' })
    }
  })

  it('maps ServerEnvError and PublicEnvError', async () => {
    const { ServerEnvError } = await import('@/lib/env')
    const { PublicEnvError } = await import('@/lib/public-env')
    expect(mapRpcError(new ServerEnvError('missing', ['CRON_SECRET'])).body.code).toBe('unavailable')
    expect(mapRpcError(new PublicEnvError(['NEXT_PUBLIC_APP_URL'])).body.code).toBe('unavailable')
  })

  it('the message matches what the proxy sends for API routes', () => {
    expect(ERROR_MESSAGES.unavailable).toBe('The service is not configured yet.')
  })
})

describe('errorResponse', () => {
  it('builds the response for each kind of mapping', async () => {
    const pig = errorResponse(mapRpcError(pgError('PT409', 'pig_changed', '{"pigEpoch":3,"level":2}')))
    expect(pig.status).toBe(409)
    expect(await pig.json()).toEqual({ error: ERROR_MESSAGES.pig_changed, code: 'pig_changed', pigEpoch: 3, level: 2 })

    const inFlight = errorResponse(
      mapRpcError(pgError('PT409', 'attempt_in_flight', '{"sameKey":false,"retryAfterSeconds":20}'))
    )
    expect(inFlight.headers.get('retry-after')).toBe('20')
    expect(await inFlight.json()).toMatchObject({ code: 'attempt_in_flight', sameKey: false, retryAfterSeconds: 20 })

    const limited = errorResponse(mapRpcError(pgError('PT429', 'rate_limited', '9')))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('9')
    expect(await limited.json()).toEqual({ error: ERROR_MESSAGES.rate_limited, code: 'rate_limited' })

    const internal = errorResponse(mapRpcError(new Error('boom')))
    expect(internal.status).toBe(500)
    expect(internal.headers.get('retry-after')).toBeNull()
    expect(internal.headers.get('cache-control')).toBe('no-store')
  })
})
