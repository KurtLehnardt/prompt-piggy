import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import { stripComments } from '@/test/source-imports'
import {
  AdminConfigPatchSchema,
  ApiErrorSchema,
  ATTEMPT_ERROR_CODES,
  ATTEMPT_FAIL_DETAILS,
  ATTEMPT_OUTCOMES,
  attemptRequestSchema,
  AttemptRequestSchema,
  AttemptResponseSchema,
  AttemptResultDTOSchema,
  DonateRequestSchema,
  DonateResultSchema,
  ERROR_CODES,
  GameResetSchema,
  HardeningRunSchema,
  HealthSchema,
  LevelParamSchema,
  LevelRulesResetSchema,
  LIST_HASH_PARAM,
  ListHashSchema,
  LivePlayersSchema,
  LiveSnapshotSchema,
  PlayerGrantSchema,
  PlayerHideSchema,
  PlayerIdParamSchema,
  promptMessageSchema,
  PROMPT_CHARS_HARD_MAX,
  RepairRequestSchema,
  RepairResultSchema,
  TestLoginSchema,
  type AdminConfigDTO,
  type AdminOverviewDTO,
  type ApiError,
  type AttemptResponseDTO,
  type AttemptResultDTO,
  type DonateResultDTO,
  type ErrorCode,
  type HealthDTO,
  type LivePlayerDTO,
  type LivePlayersDTO,
  type LiveSnapshotDTO,
  type RepairResultDTO,
} from '@/types/api'

/**
 * src/types/api.ts (docs/ARCHITECTURE.md section 7, revision 2, with the
 * REVIEW-3 slice amendments). Request schemas are zod strictObjects; the
 * response schemas must describe exactly the DTO types (checked by tsc).
 */
const UUID = '00000000-0000-4000-8000-000000000001'
const API_SOURCE = readFileSync(path.join(__dirname, '../../types/api.ts'), 'utf8')

describe('enumerations', () => {
  it('ErrorCode covers the section 7 table, including level_not_configured and unavailable', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'invalid_request',
        'unauthorized',
        'insufficient_funds',
        'forbidden',
        'not_found',
        'attempt_in_flight',
        'already_finalized',
        'pig_changed',
        'nothing_to_repair',
        'stale_parent',
        'invalid_amount',
        'invariant_violation',
        'rate_limited',
        'daily_cap',
        'kill_switch',
        'spend_cap_reached',
        'level_not_configured',
        'unavailable',
        'internal',
      ].sort()
    )
    expectTypeOf<'unavailable'>().toExtend<ErrorCode>()
    expectTypeOf<'level_not_configured'>().toExtend<ErrorCode>()
  })

  it('AttemptOutcome includes late_win and never pending', () => {
    expect(ATTEMPT_OUTCOMES).toContain('late_win')
    expect(ATTEMPT_OUTCOMES).not.toContain('pending')
  })

  it('attempt error codes include upstream_config and match the SQL error_code check (R3-01)', () => {
    expect(ATTEMPT_ERROR_CODES).toContain('upstream_config')
    expect(ATTEMPT_ERROR_CODES).toEqual(
      expect.arrayContaining(['upstream_error', 'upstream_timeout', 'upstream_config', 'reaped'])
    )
    for (const code of [...ATTEMPT_ERROR_CODES, ...ATTEMPT_FAIL_DETAILS]) {
      expect(code).toMatch(/^[a-z_]{3,40}$/)
    }
    expect(new Set([...ATTEMPT_ERROR_CODES, ...ATTEMPT_FAIL_DETAILS]).size).toBe(
      ATTEMPT_ERROR_CODES.length + ATTEMPT_FAIL_DETAILS.length
    )
  })

  it('the shared constant lists are frozen', () => {
    for (const list of [ERROR_CODES, ATTEMPT_OUTCOMES, ATTEMPT_ERROR_CODES, ATTEMPT_FAIL_DETAILS]) {
      expect(Object.isFrozen(list)).toBe(true)
    }
  })

  it('declares no type for GET /api/attempts/[id] (R2-S3)', () => {
    const code = stripComments(API_SOURCE)
    expect(code).not.toMatch(/attempts\/\[id\]/)
    expect(code).not.toMatch(/AttemptStatus|AttemptLookup|GetAttempt/)
  })
})

describe('AttemptRequestSchema', () => {
  const ok = { message: 'Hello Penny, I am the branch manager.', idempotencyKey: UUID, expectedEpoch: 1 }

  it('accepts { message, idempotencyKey, expectedEpoch }', () => {
    expect(AttemptRequestSchema.parse(ok)).toEqual(ok)
    expect(AttemptRequestSchema.safeParse({ ...ok, message: 'x'.repeat(PROMPT_CHARS_HARD_MAX) }).success).toBe(true)
  })

  it.each([
    ['an unknown key', { ...ok, userId: UUID }],
    ['a missing message', { idempotencyKey: UUID, expectedEpoch: 1 }],
    ['an empty message', { ...ok, message: '' }],
    ['a blank message', { ...ok, message: ' \n\t ' }],
    ['a message over the hard maximum', { ...ok, message: 'x'.repeat(PROMPT_CHARS_HARD_MAX + 1) }],
    ['a NUL character', { ...ok, message: 'hi\u0000there' }],
    ['a lone surrogate', { ...ok, message: 'hi \ud83d there' }],
    ['a non-string message', { ...ok, message: 42 }],
    ['a non-uuid key', { ...ok, idempotencyKey: 'not-a-uuid' }],
    ['a fractional epoch', { ...ok, expectedEpoch: 1.5 }],
    ['a negative epoch', { ...ok, expectedEpoch: -1 }],
    ['a string epoch', { ...ok, expectedEpoch: '1' }],
  ])('rejects %s', (_label, body) => {
    expect(AttemptRequestSchema.safeParse(body).success).toBe(false)
  })

  it('accepts emoji and other well-formed text', () => {
    expect(AttemptRequestSchema.safeParse({ ...ok, message: 'Oink 🐷, por favor' }).success).toBe(true)
  })

  it('attemptRequestSchema(maxChars) enforces the configured MAX_PROMPT_CHARS', () => {
    const schema = attemptRequestSchema(2000)
    expect(schema.safeParse({ ...ok, message: 'x'.repeat(2000) }).success).toBe(true)
    expect(schema.safeParse({ ...ok, message: 'x'.repeat(2001) }).success).toBe(false)
  })

  it.each([0, 4001, 1.5])('promptMessageSchema(%s) throws', (maxChars) => {
    expect(() => promptMessageSchema(maxChars)).toThrow(RangeError)
  })
})

describe('the other request schemas', () => {
  it.each([
    ['RepairRequestSchema', RepairRequestSchema, { idempotencyKey: UUID }],
    ['DonateRequestSchema', DonateRequestSchema, { amountCents: 1, idempotencyKey: UUID }],
    ['AdminConfigPatchSchema', AdminConfigPatchSchema, { killSwitch: true }],
    ['AdminConfigPatchSchema (all)', AdminConfigPatchSchema, { killSwitch: false, attemptsEnabled: true, hardeningEnabled: false }],
    ['GameResetSchema', GameResetSchema, { confirm: true }],
    ['GameResetSchema with a level', GameResetSchema, { confirm: true, level: 5 }],
    ['LevelRulesResetSchema', LevelRulesResetSchema, { confirm: true }],
    ['PlayerHideSchema', PlayerHideSchema, { hidden: true }],
    ['PlayerGrantSchema', PlayerGrantSchema, { amountCents: 10000, idempotencyKey: UUID }],
    ['HardeningRunSchema', HardeningRunSchema, {}],
    ['HardeningRunSchema with a job', HardeningRunSchema, { jobId: UUID }],
    ['TestLoginSchema', TestLoginSchema, { email: 'player@example.com' }],
  ] as const)('%s accepts a valid body', (_label, schema, body) => {
    expect((schema as z.ZodType).safeParse(body).success).toBe(true)
  })

  it.each([
    ['RepairRequestSchema with a price', RepairRequestSchema, { idempotencyKey: UUID, priceCents: 0 }],
    ['RepairRequestSchema without a key', RepairRequestSchema, {}],
    ['DonateRequestSchema with 0 cents', DonateRequestSchema, { amountCents: 0, idempotencyKey: UUID }],
    ['DonateRequestSchema with fractional cents', DonateRequestSchema, { amountCents: 1.5, idempotencyKey: UUID }],
    ['DonateRequestSchema with a string amount', DonateRequestSchema, { amountCents: '100', idempotencyKey: UUID }],
    ['DonateRequestSchema with an extra key', DonateRequestSchema, { amountCents: 1, idempotencyKey: UUID, to: 'cncf' }],
    ['AdminConfigPatchSchema with nothing', AdminConfigPatchSchema, {}],
    ['AdminConfigPatchSchema with presenceMode', AdminConfigPatchSchema, { presenceMode: 'poll' }],
    ['AdminConfigPatchSchema with a string flag', AdminConfigPatchSchema, { killSwitch: 'true' }],
    ['GameResetSchema without confirm', GameResetSchema, {}],
    ['GameResetSchema with confirm false', GameResetSchema, { confirm: false }],
    ['GameResetSchema with level 6', GameResetSchema, { confirm: true, level: 6 }],
    ['GameResetSchema with level 0', GameResetSchema, { confirm: true, level: 0 }],
    ['LevelRulesResetSchema with an extra key', LevelRulesResetSchema, { confirm: true, version: 2 }],
    ['PlayerHideSchema with a string', PlayerHideSchema, { hidden: 'yes' }],
    ['PlayerGrantSchema with 0 cents', PlayerGrantSchema, { amountCents: 0, idempotencyKey: UUID }],
    ['PlayerGrantSchema with a user id', PlayerGrantSchema, { amountCents: 1, idempotencyKey: UUID, userId: UUID }],
    ['HardeningRunSchema with a bad job id', HardeningRunSchema, { jobId: '1' }],
    ['TestLoginSchema with a bad email', TestLoginSchema, { email: 'nope' }],
  ] as const)('rejects %s', (_label, schema, body) => {
    expect((schema as z.ZodType).safeParse(body).success).toBe(false)
  })

  it('parses route parameters', () => {
    expect(LevelParamSchema.parse('3')).toBe(3)
    for (const value of ['0', '6', '03', '1.0', 'one', '']) {
      expect(LevelParamSchema.safeParse(value).success).toBe(false)
    }
    expect(PlayerIdParamSchema.safeParse(UUID).success).toBe(true)
    expect(PlayerIdParamSchema.safeParse('42').success).toBe(false)
  })
})

describe('response schemas', () => {
  const result: AttemptResultDTO = {
    id: UUID,
    level: 2,
    outcome: 'fail',
    reply: 'Sorry, I cannot do that.',
    technique: 'roleplay_persona',
    cracks: 1,
    crackEvent: 'crack',
    priceCents: 100,
    payoutCents: 0,
    refundCents: 0,
    refundWithheld: false,
    walletBalanceCents: 1900,
    auraBps: 0,
    game: { treasuryCents: 600, level: 2, pigEpoch: 3 },
    levelAdvanced: null,
  }

  it('the output types are exactly the DTO types', () => {
    expectTypeOf<z.output<typeof AttemptResultDTOSchema>>().toEqualTypeOf<AttemptResultDTO>()
    expectTypeOf<z.output<typeof AttemptResponseSchema>>().toEqualTypeOf<AttemptResponseDTO>()
    expectTypeOf<z.output<typeof RepairResultSchema>>().toEqualTypeOf<RepairResultDTO>()
    expectTypeOf<z.output<typeof DonateResultSchema>>().toEqualTypeOf<DonateResultDTO>()
    expectTypeOf<z.output<typeof ApiErrorSchema>>().toEqualTypeOf<ApiError>()
    expectTypeOf<z.output<typeof LivePlayersSchema>>().toEqualTypeOf<LivePlayersDTO>()
    expectTypeOf<z.output<typeof LiveSnapshotSchema>>().toEqualTypeOf<LiveSnapshotDTO>()
    expectTypeOf<z.output<typeof HealthSchema>>().toEqualTypeOf<HealthDTO>()
  })

  it('parses an attempt response, including a late win and an error with refundWithheld', () => {
    expect(AttemptResponseSchema.parse({ attempt: result })).toEqual({ attempt: result })
    const lateWin = { ...result, outcome: 'late_win', crackEvent: 'none' }
    expect(AttemptResultDTOSchema.safeParse(lateWin).success).toBe(true)
    const withheld = { ...result, outcome: 'error', technique: 'unknown', refundWithheld: true, crackEvent: 'none' }
    expect(AttemptResultDTOSchema.safeParse(withheld).success).toBe(true)
    expect(AttemptResultDTOSchema.safeParse({ ...result, outcome: 'pending' }).success).toBe(false)
    expect(AttemptResultDTOSchema.safeParse({ ...result, cracks: 4 }).success).toBe(false)
    expect(AttemptResultDTOSchema.safeParse({ ...result, auraBps: 10001 }).success).toBe(false)
  })

  it('the wall list carries a hash and has an unchanged variant without the list (R3-02)', () => {
    const player: LivePlayerDTO = { id: UUID, name: 'Ada', avatarUrl: null, auraBps: 2500, lastSeenBucket: 0 }
    const hash = 'a'.repeat(32)
    expect(LivePlayersSchema.parse({ unchanged: false, listHash: hash, players: [player] })).toEqual({
      unchanged: false,
      listHash: hash,
      players: [player],
    })
    expect(LivePlayersSchema.parse({ unchanged: true, listHash: hash })).toEqual({ unchanged: true, listHash: hash })
    expect(LivePlayersSchema.safeParse({ unchanged: false, players: [player] }).success).toBe(false)
    expect(Object.keys(player).sort()).toEqual(['auraBps', 'avatarUrl', 'id', 'lastSeenBucket', 'name'])
    expect(LIST_HASH_PARAM).toBe('h')
    expect(ListHashSchema.safeParse('A'.repeat(32)).success).toBe(false)
    expect(ListHashSchema.safeParse('ab12').success).toBe(false)
  })

  it('the public snapshot and the admin config have no player list or presence mode (R2-07, R2-S1)', () => {
    expectTypeOf<LiveSnapshotDTO>().not.toHaveProperty('players')
    expectTypeOf<AdminConfigDTO>().not.toHaveProperty('presenceMode')
    expectTypeOf<LivePlayerDTO>().not.toHaveProperty('email')
    expectTypeOf<AdminOverviewDTO['spend']>().toHaveProperty('degradedAttempts')
    expectTypeOf<AdminOverviewDTO['spend']>().toHaveProperty('configErrorAttempts')
    expectTypeOf<AdminOverviewDTO['hardening']>().toHaveProperty('keywordFillByLevel')
    expectTypeOf<AttemptResultDTO>().toHaveProperty('refundWithheld')
  })

  it('the error union discriminates on code', () => {
    expect(ApiErrorSchema.safeParse({ error: 'x', code: 'pig_changed' }).success).toBe(false)
    expect(ApiErrorSchema.safeParse({ error: 'x', code: 'pig_changed', pigEpoch: 2, level: 1 }).success).toBe(true)
    expect(ApiErrorSchema.safeParse({ error: 'x', code: 'attempt_in_flight', sameKey: true, retryAfterSeconds: 0 }).success).toBe(false)
    expect(ApiErrorSchema.safeParse({ error: 'x', code: 'unavailable' }).success).toBe(true)
    expect(ApiErrorSchema.safeParse({ error: 'x', code: 'teapot' }).success).toBe(false)
  })
})
