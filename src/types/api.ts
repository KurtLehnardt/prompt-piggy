import { z } from 'zod'
import { ATTACK_TECHNIQUES, type AttackTechnique } from '@/lib/config/techniques'
import type { LevelId } from '@/lib/config/levels'

/**
 * Every request body, response DTO, error variant, and error code of the HTTP
 * API (docs/ARCHITECTURE.md section 7, revision 2; R1-23, R2-05, R2-20).
 *
 * PP-04 declares all of them up front, and no later task edits this file. It
 * includes the slice amendments from REVIEW-3:
 *
 * - `unavailable` (503) for a missing or partial environment (R3-14).
 * - Attempt error codes for system errors, including `upstream_config` for a
 *   Decisions or Core 401, 403, 404, or other non-429 4xx that is not input
 *   rejection (R3-01).
 * - A wall list that carries a hash, so a poll whose hash matches gets an
 *   `unchanged` answer without the list (R3-02).
 * - The idempotent re-POST recovery shapes: the stored DTO for a finalized
 *   key, and `attempt_in_flight` with `sameKey` and `retryAfterSeconds` of at
 *   least 1 for a pending one (R2-05, R3-06).
 *
 * This module is shared by server and browser code, so it holds no secret and
 * reads no environment variable. There is deliberately no type for
 * `GET /api/attempts/[id]`: that route does not exist (R2-S3).
 */

export type { AttackTechnique, LevelId }

/** Integer cents of mocked US dollars (CH-1). */
export type Cents = number

/** Basis points from 0 to 10,000; aura is server-computed (CH-2). */
export type Bps = number

/** The hard maximum attempt length; MAX_PROMPT_CHARS (default 2,000) is at most this. */
export const PROMPT_CHARS_HARD_MAX = 4000

// ---------------------------------------------------------------------------
// Enumerations

/** Final outcomes of an attempt. `pending` exists only inside the database. */
export const ATTEMPT_OUTCOMES = Object.freeze(['win', 'late_win', 'fail', 'blocked', 'leak_blocked', 'error'] as const)
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number]

export const CRACK_EVENTS = Object.freeze(['none', 'crack', 'shatter', 'repaired'] as const)
export type CrackEvent = (typeof CRACK_EVENTS)[number]

export type CrackCount = 0 | 1 | 2 | 3

/**
 * Detail codes stored in `attempts.error_code` for outcome `error`: system
 * faults the attacker cannot produce. Each is refunded within the per-player
 * refund budget, and none changes cracks (section 9.4, R2-01).
 *
 * - `upstream_error`: an OpenAI connection error, 429, or 5xx.
 * - `upstream_timeout`: the attempt's abort timeout fired.
 * - `upstream_config`: a fault in our own request or configuration, logged at
 *   error level. For the Core LLM it is any OpenAI 4xx other than 429 and
 *   input rejection (section 8.4). For the Decisions tripwire it is a 401,
 *   403, 404, or any other non-429 4xx that is not an input-rejection 400
 *   (R3-01).
 * - `reaped`: a pending attempt stranded by a killed function, including a
 *   stale same-key attempt reaped by a re-POST (R3-06).
 * - `reply_unstorable`: `record_attempt` could not store the reply, so the
 *   attempt settles as an error under the refund budget instead of staying
 *   pending (R3-07).
 * - `level_config_invalid`: a level 4 or 5 payload failed
 *   resolveLevelConfig() after the fee was taken, an operator fault (R3-08).
 */
export const ATTEMPT_ERROR_CODES = Object.freeze([
  'upstream_error',
  'upstream_timeout',
  'upstream_config',
  'reaped',
  'reply_unstorable',
  'level_config_invalid',
] as const)
export type AttemptErrorCode = (typeof ATTEMPT_ERROR_CODES)[number]

/**
 * Optional detail codes stored in `attempts.error_code` for outcome `fail`.
 * The attacker can produce every one of them, so none is refunded (R2-01).
 */
export const ATTEMPT_FAIL_DETAILS = Object.freeze([
  'incomplete',
  'content_filter',
  'empty_output',
  'input_rejected',
  'model_behavior',
  'max_turns',
] as const)
export type AttemptFailDetail = (typeof ATTEMPT_FAIL_DETAILS)[number]

export const LIVE_FEED_TYPES = Object.freeze(['attempt', 'level_advanced', 'hardened', 'rules_reset', 'game_reset'] as const)
export type LiveFeedType = (typeof LIVE_FEED_TYPES)[number]

/**
 * Stable machine codes of every error response (section 7 error table).
 * src/lib/errors.ts maps each one to its HTTP status.
 */
export const ERROR_CODES = Object.freeze([
  'invalid_request', // 400
  'unauthorized', // 401
  'insufficient_funds', // 402
  'forbidden', // 403
  'not_found', // 404
  'attempt_in_flight', // 409
  'already_finalized', // 409
  'pig_changed', // 409
  'nothing_to_repair', // 409
  'stale_parent', // 409
  'invalid_amount', // 422
  'invariant_violation', // 422
  'rate_limited', // 429
  'daily_cap', // 429
  'kill_switch', // 503
  'spend_cap_reached', // 503
  'level_not_configured', // 503
  'unavailable', // 503
  'internal', // 500
] as const)
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Error codes whose body carries no fields beyond `error` and `code`. */
export type PlainErrorCode = Exclude<ErrorCode, 'pig_changed' | 'attempt_in_flight'>

// ---------------------------------------------------------------------------
// Error bodies

/** The pig moved since the client read its epoch; nothing was charged (R2-20). */
export type PigChangedError = {
  error: string
  code: 'pig_changed'
  /** The current epoch, which the client adopts. 0 means unknown: refetch the snapshot. */
  pigEpoch: number
  /** The current level, which the client adopts. */
  level: LevelId
}

/** An attempt is still running (R2-05). */
export type AttemptInFlightError = {
  error: string
  code: 'attempt_in_flight'
  /**
   * True: this idempotency key's own attempt is pending; re-post the same key
   * with backoff until the stored DTO arrives. False: another attempt of this
   * player is pending; re-enable Send after retryAfterSeconds.
   */
  sameKey: boolean
  /** Whole seconds, at least 1 (R3-06). Also sent as the Retry-After header. */
  retryAfterSeconds: number
}

export type PlainApiError = { error: string; code: PlainErrorCode }

/**
 * Every error body: `{ error, code }`, plus the hint fields for pig_changed
 * and attempt_in_flight. `error` is human-readable and never holds internals.
 * A 429 also sends a Retry-After header.
 */
export type ApiError = PigChangedError | AttemptInFlightError | PlainApiError

// ---------------------------------------------------------------------------
// Attempts, wallet, and donations

/** POST /api/attempts, 200. A repeated key for a finalized attempt returns the same stored DTO. */
export type AttemptResultDTO = {
  id: string
  /** The level this attempt faced. */
  level: LevelId
  outcome: AttemptOutcome
  /** Plain text, at most 600 characters; fixed copy for every outcome except fail. */
  reply: string | null
  /** Display only. */
  technique: AttackTechnique
  /** Server state after the transition. */
  cracks: CrackCount
  crackEvent: CrackEvent
  priceCents: Cents
  payoutCents: Cents
  refundCents: Cents
  /** A system error over the per-player refund budget kept the fee (R2-01). */
  refundWithheld: boolean
  walletBalanceCents: Cents
  /** 0 to 10,000, server-computed. */
  auraBps: Bps
  game: { treasuryCents: Cents; level: LevelId; pigEpoch: number }
  levelAdvanced: { from: LevelId; to: LevelId } | null
}

/** The 200 body of POST /api/attempts. */
export type AttemptResponseDTO = { attempt: AttemptResultDTO }

/** POST /api/wallet/repair, 200. */
export type RepairResultDTO = { cracks: 0; walletBalanceCents: Cents; auraBps: Bps; treasuryCents: Cents }

/** POST /api/wallet/donate, 200. */
export type DonateResultDTO = { walletBalanceCents: Cents; totalDonatedCents: Cents; auraBps: Bps }

// ---------------------------------------------------------------------------
// Presence wall and /live

/**
 * One player on the wall. Exactly the columns the wall RPCs return (R3-02):
 * no email, balance, crack count, donation total, or raw timestamp.
 */
export type LivePlayerDTO = {
  id: string
  name: string
  avatarUrl: string | null
  auraBps: Bps
  /**
   * Coarse recency computed in SQL (PP-12), never a raw timestamp: 0 for the
   * most recent bucket and larger for older ones. The bucket is at least as
   * wide as the 60-second write throttle, so an active player's value, and
   * with it the list hash, stays the same between that player's pings.
   */
  lastSeenBucket: number
}

/**
 * The wall list from /live/players and POST /api/presence/ping (R2-07,
 * R3-02). `listHash` is a hex digest of the list computed in SQL. A client
 * sends the hash it last received in the LIST_HASH_PARAM query parameter, and
 * when it still matches the server answers `{ unchanged: true }` without the
 * list. The game-page strip asks for at most about 30 players; /live shows
 * everyone.
 */
export type LivePlayersDTO =
  | { unchanged: false; listHash: string; players: LivePlayerDTO[] }
  | { unchanged: true; listHash: string }

/** The query parameter that carries the client's last wall-list hash. */
export const LIST_HASH_PARAM = 'h'

/** A wall-list hash: 16 to 64 lowercase hex characters. */
export const ListHashSchema = z.string().regex(/^[0-9a-f]{16,64}$/)

export type LiveFeedItemDTO = {
  id: number
  at: string
  type: LiveFeedType
  level: number | null
  /** A pseudonymous id; names come only from LivePlayersDTO. */
  playerId: string | null
  outcome: AttemptOutcome | null
  technique: AttackTechnique | null
  amountCents: Cents | null
  ruleVersion: number | null
}

/** GET /api/live/snapshot: public and CDN-cached, so no player list, names, or photos (R2-07). */
export type LiveSnapshotDTO = {
  game: {
    treasuryCents: Cents
    level: number
    levelName: string
    pigEpoch: number
    totals: Record<'attempts' | 'wins' | 'paidOutCents', number>
  }
  levels: { id: number; name: string; ruleVersion: number; lastHardenedAt: string | null }[]
  /** The newest 20 rows. */
  feed: LiveFeedItemDTO[]
  config: { attemptsEnabled: boolean; attemptPriceCents: Cents; repairPriceCents: Cents }
}

/** GET /api/health, 200. */
export type HealthDTO = { ok: true; attemptsEnabled: boolean }

// ---------------------------------------------------------------------------
// Admin, cron, smoke

export type AdminConfigDTO = { killSwitch: boolean; attemptsEnabled: boolean; hardeningEnabled: boolean }

export type AdminOverviewDTO = {
  config: AdminConfigDTO
  spend: {
    day: string
    capMicros: number
    attemptMicros: number
    hardeningMicros: number
    /** Attempts today that ran without the tripwire because Decisions was unavailable (R2-S3). */
    degradedAttempts: number
    /** Attempts today that ended as error with upstream_config, a configuration fault (R3-01). */
    configErrorAttempts: number
  }
  game: LiveSnapshotDTO['game']
  hardening: {
    queued: number
    processing: number
    needsReview: number
    saturatedByLevel: Record<number, number>
    /** R2-15. */
    keywordFillByLevel: Record<number, number>
  }
  players: (LivePlayerDTO & { hidden: boolean })[]
}

/** PATCH /api/admin/config, 200. */
export type AdminConfigResponseDTO = { config: AdminConfigDTO }

/** POST /api/admin/game/reset, 200. */
export type GameResetResultDTO = { level: LevelId; pigEpoch: number }

/** POST /api/admin/levels/[level]/reset, 200. */
export type LevelRulesResetResultDTO = { activeRuleSetId: string; version: number }

/** POST /api/admin/hardening/run, 200. */
export type HardeningRunResultDTO = { processed: number }

/** POST /api/admin/players/[id]/hide, 200. */
export type PlayerHideResultDTO = { ok: true }

/** POST /api/admin/players/[id]/grant, 200. */
export type PlayerGrantResultDTO = { walletBalanceCents: Cents }

/** GET /api/cron/daily, 200. */
export type CronDailyResultDTO = { purgedPrompts: number; prunedFeed: number; reaped: number; swept: number }

/** POST /api/cron/hardening, 202. */
export type CronHardeningAcceptedDTO = { accepted: true }

/** One check of the preview smoke route. `detail` never holds a secret, a prompt, or a reply. */
export type SmokeCheckDTO = { name: string; ok: boolean; durationMs: number; detail: string | null }

/** POST /api/smoke, 200, previews only (PP-02b). */
export type SmokeReportDTO = { ok: boolean; startedAt: string; checks: SmokeCheckDTO[] }

// ---------------------------------------------------------------------------
// Request schemas (zod strictObject: an unknown key is a 400)

/** Level ids 1 to 5. */
export const LevelIdSchema = z.literal([1, 2, 3, 4, 5])

/** An idempotency key, generated once per submission with crypto.randomUUID(). */
export const IdempotencyKeySchema = z.uuid()

/** A positive integer number of cents. */
export const PositiveCentsSchema = z.int().min(1)

/**
 * The attempt message: 1 to maxChars UTF-16 code units, not blank, well-formed
 * UTF-16 (no lone surrogates), and no NUL. Text the database or OpenAI would
 * reject is refused here with a 400, before anything is charged (R3-N3).
 */
export function promptMessageSchema(maxChars: number) {
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > PROMPT_CHARS_HARD_MAX) {
    throw new RangeError(`maxChars must be an integer from 1 to ${PROMPT_CHARS_HARD_MAX}.`)
  }
  return z
    .string()
    .min(1)
    .max(maxChars)
    .refine((value) => value.trim().length > 0, { message: 'The message is blank.' })
    .refine((value) => value.isWellFormed() && !value.includes('\u0000'), {
      message: 'The message contains characters that cannot be stored.',
    })
}

/**
 * POST /api/attempts. The route builds it with the configured
 * MAX_PROMPT_CHARS; AttemptRequestSchema uses the hard maximum.
 */
export function attemptRequestSchema(maxChars: number) {
  return z.strictObject({
    message: promptMessageSchema(maxChars),
    idempotencyKey: IdempotencyKeySchema,
    expectedEpoch: z.int().min(0),
  })
}

export const AttemptRequestSchema = attemptRequestSchema(PROMPT_CHARS_HARD_MAX)
export type AttemptRequest = z.infer<typeof AttemptRequestSchema>

/** POST /api/wallet/repair. The price is never sent; it comes from app_config. */
export const RepairRequestSchema = z.strictObject({ idempotencyKey: IdempotencyKeySchema })
export type RepairRequest = z.infer<typeof RepairRequestSchema>

/** POST /api/wallet/donate. The upper bound is the wallet balance, checked in SQL. */
export const DonateRequestSchema = z.strictObject({
  amountCents: PositiveCentsSchema,
  idempotencyKey: IdempotencyKeySchema,
})
export type DonateRequest = z.infer<typeof DonateRequestSchema>

/** PATCH /api/admin/config. At least one setting must be present. */
export const AdminConfigPatchSchema = z
  .strictObject({
    killSwitch: z.boolean().optional(),
    attemptsEnabled: z.boolean().optional(),
    hardeningEnabled: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to change.' })
export type AdminConfigPatch = z.infer<typeof AdminConfigPatchSchema>

/** POST /api/admin/game/reset. */
export const GameResetSchema = z.strictObject({ confirm: z.literal(true), level: LevelIdSchema.optional() })
export type GameResetRequest = z.infer<typeof GameResetSchema>

/** POST /api/admin/levels/[level]/reset. */
export const LevelRulesResetSchema = z.strictObject({ confirm: z.literal(true) })
export type LevelRulesResetRequest = z.infer<typeof LevelRulesResetSchema>

/** The [level] route segment of /api/admin/levels/[level]/reset. */
export const LevelParamSchema = z
  .string()
  .regex(/^[1-5]$/)
  .transform((value) => Number(value) as LevelId)

/** The [id] route segment of the admin player routes. */
export const PlayerIdParamSchema = z.uuid()

/** POST /api/admin/players/[id]/hide. */
export const PlayerHideSchema = z.strictObject({ hidden: z.boolean() })
export type PlayerHideRequest = z.infer<typeof PlayerHideSchema>

/** POST /api/admin/players/[id]/grant. The upper bound is admin_grant_max_cents, checked in SQL. */
export const PlayerGrantSchema = z.strictObject({
  amountCents: PositiveCentsSchema,
  idempotencyKey: IdempotencyKeySchema,
})
export type PlayerGrantRequest = z.infer<typeof PlayerGrantSchema>

/** POST /api/cron/hardening and POST /api/admin/hardening/run. */
export const HardeningRunSchema = z.strictObject({ jobId: z.uuid().optional() })
export type HardeningRunRequest = z.infer<typeof HardeningRunSchema>

/** POST /api/test/login, E2E mode only. */
export const TestLoginSchema = z.strictObject({ email: z.email() })
export type TestLoginRequest = z.infer<typeof TestLoginSchema>

// ---------------------------------------------------------------------------
// Response schemas, for browser code that parses what the server sent

const CentsSchema = z.int()
const NonNegativeCentsSchema = z.int().min(0)
const BpsSchema = z.int().min(0).max(10_000)
const CrackCountSchema = z.literal([0, 1, 2, 3])
const AttackTechniqueSchema = z.enum(ATTACK_TECHNIQUES)
const AttemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES)

export const AttemptResultDTOSchema = z.object({
  id: z.string(),
  level: LevelIdSchema,
  outcome: AttemptOutcomeSchema,
  reply: z.string().nullable(),
  technique: AttackTechniqueSchema,
  cracks: CrackCountSchema,
  crackEvent: z.enum(CRACK_EVENTS),
  priceCents: NonNegativeCentsSchema,
  payoutCents: NonNegativeCentsSchema,
  refundCents: NonNegativeCentsSchema,
  refundWithheld: z.boolean(),
  walletBalanceCents: CentsSchema,
  auraBps: BpsSchema,
  game: z.object({ treasuryCents: CentsSchema, level: LevelIdSchema, pigEpoch: z.int() }),
  levelAdvanced: z.object({ from: LevelIdSchema, to: LevelIdSchema }).nullable(),
})

export const AttemptResponseSchema = z.object({ attempt: AttemptResultDTOSchema })

export const RepairResultSchema = z.object({
  cracks: z.literal(0),
  walletBalanceCents: CentsSchema,
  auraBps: BpsSchema,
  treasuryCents: CentsSchema,
})

export const DonateResultSchema = z.object({
  walletBalanceCents: CentsSchema,
  totalDonatedCents: NonNegativeCentsSchema,
  auraBps: BpsSchema,
})

const PLAIN_ERROR_CODES = ERROR_CODES.filter(
  (code): code is PlainErrorCode => code !== 'pig_changed' && code !== 'attempt_in_flight'
)

export const ApiErrorSchema = z.union([
  z.object({ error: z.string(), code: z.literal('pig_changed'), pigEpoch: z.int().min(0), level: LevelIdSchema }),
  z.object({
    error: z.string(),
    code: z.literal('attempt_in_flight'),
    sameKey: z.boolean(),
    retryAfterSeconds: z.int().min(1),
  }),
  z.object({ error: z.string(), code: z.enum(PLAIN_ERROR_CODES) }),
])

export const LivePlayerDTOSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  auraBps: BpsSchema,
  lastSeenBucket: z.int().min(0),
})

export const LivePlayersSchema = z.union([
  z.object({ unchanged: z.literal(false), listHash: ListHashSchema, players: z.array(LivePlayerDTOSchema) }),
  z.object({ unchanged: z.literal(true), listHash: ListHashSchema }),
])

export const LiveFeedItemDTOSchema = z.object({
  id: z.int(),
  at: z.string(),
  type: z.enum(LIVE_FEED_TYPES),
  level: z.int().nullable(),
  playerId: z.string().nullable(),
  outcome: AttemptOutcomeSchema.nullable(),
  technique: AttackTechniqueSchema.nullable(),
  amountCents: CentsSchema.nullable(),
  ruleVersion: z.int().nullable(),
})

export const LiveSnapshotSchema = z.object({
  game: z.object({
    treasuryCents: CentsSchema,
    level: z.int(),
    levelName: z.string(),
    pigEpoch: z.int(),
    totals: z.object({ attempts: z.int(), wins: z.int(), paidOutCents: CentsSchema }),
  }),
  levels: z.array(
    z.object({ id: z.int(), name: z.string(), ruleVersion: z.int(), lastHardenedAt: z.string().nullable() })
  ),
  feed: z.array(LiveFeedItemDTOSchema),
  config: z.object({
    attemptsEnabled: z.boolean(),
    attemptPriceCents: NonNegativeCentsSchema,
    repairPriceCents: NonNegativeCentsSchema,
  }),
})

export const HealthSchema = z.object({ ok: z.literal(true), attemptsEnabled: z.boolean() })
