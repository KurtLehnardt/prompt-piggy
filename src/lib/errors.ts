import { NextResponse } from 'next/server'
import { isLevelId, type LevelId } from '@/lib/config/levels'
import { formatCents } from '@/lib/money/format'
import type {
  ApiError,
  AttemptInFlightError,
  ErrorCode,
  PigChangedError,
  PlainErrorCode,
} from '@/types/api'

/**
 * Error responses and the database error mapping (docs/ARCHITECTURE.md
 * section 7; R1-23, R2-05, R2-20, R3-14).
 *
 * Every error body is `{ error, code }` (skylite's `{ error }` plus a stable
 * machine code), with the hint fields of the ApiError union for pig_changed
 * and attempt_in_flight. Messages are fixed copy: no SQL text, hint, detail,
 * stack, prompt, or reply ever reaches a response.
 *
 * Custom database errors use PostgREST's PTnnn SQLSTATE convention, and the
 * message is a token that selects the code, for example
 * `raise exception 'pig_changed' using errcode = 'PT409', hint = '...'`.
 * The hints this module parses, which the RPCs (PP-18, PP-22) must emit:
 *
 * | Token                | Hint                                                     |
 * |----------------------|----------------------------------------------------------|
 * | `pig_changed`        | `{"pigEpoch": <current epoch>, "level": <current level>}` |
 * | `attempt_in_flight`  | `{"sameKey": <boolean>, "retryAfterSeconds": <seconds>}`  |
 * | `insufficient_funds` | `{"balanceCents": <balance>, "priceCents": <price>}`      |
 * | `rate_limited`       | seconds until the next token, as a number or `{"retryAfterSeconds": n}` |
 * | `daily_cap`          | optional; defaults to the seconds until the next UTC midnight |
 *
 * A malformed hint falls back to safe defaults and never throws.
 */

/** The HTTP status of every error code (section 7 error table). */
export const ERROR_STATUS = Object.freeze({
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
} as const satisfies Record<ErrorCode, number>)

/** Default player-facing copy for every code. */
export const ERROR_MESSAGES = Object.freeze({
  invalid_request: 'The request is not valid.',
  unauthorized: 'Sign in required.',
  insufficient_funds: 'Your wallet balance is too low.',
  forbidden: 'You are not allowed to do that.',
  not_found: 'Not found.',
  attempt_in_flight: 'Another attack from your account is still running.',
  already_finalized: 'This attack has already finished.',
  pig_changed: 'The pig just leveled up! Review your attack and send again.',
  nothing_to_repair: 'Your glass has no cracks to repair.',
  stale_parent: 'The rules changed while this was running. Try again.',
  invalid_amount: 'That amount is not valid.',
  invariant_violation: 'Something went wrong. Nothing was changed.',
  rate_limited: 'Slow down a little, then try again.',
  daily_cap: 'You reached the attack limit for today (UTC). Come back tomorrow.',
  kill_switch: 'The vault is closed right now.',
  spend_cap_reached: 'The vault is closed for today: the daily budget is used up.',
  level_not_configured: 'This level is not ready yet.',
  unavailable: 'The service is not configured yet.',
  internal: 'Something went wrong.',
} as const satisfies Record<ErrorCode, string>)

/** The same-key in-flight message, for a client re-posting its own key. */
export const SAME_KEY_IN_FLIGHT_MESSAGE = 'This attack is still running.'

type PigChangedDetails = Pick<PigChangedError, 'pigEpoch' | 'level'>
type AttemptInFlightDetails = Pick<AttemptInFlightError, 'sameKey' | 'retryAfterSeconds'>
type RetryDetails = { retryAfterSeconds?: number | null }

const NO_STORE = 'no-store'

/** Whole seconds for a Retry-After value: at least 1, at most one day. */
export function clampRetryAfterSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 1
  return Math.min(86_400, Math.max(1, Math.ceil(seconds)))
}

/**
 * Builds an error response. `status` is normally ERROR_STATUS[code]. The body
 * is `{ error: message ?? ERROR_MESSAGES[code], code }` plus, for pig_changed
 * and attempt_in_flight, the hint fields, which those codes require. A
 * `retryAfterSeconds` also sets the Retry-After header. Error responses are
 * never cached.
 */
export function jsonError(
  code: 'pig_changed',
  status: number,
  message: string | undefined,
  details: PigChangedDetails
): NextResponse<ApiError>
export function jsonError(
  code: 'attempt_in_flight',
  status: number,
  message: string | undefined,
  details: AttemptInFlightDetails
): NextResponse<ApiError>
export function jsonError(
  code: PlainErrorCode,
  status: number,
  message?: string,
  details?: RetryDetails
): NextResponse<ApiError>
export function jsonError(
  code: ErrorCode,
  status: number,
  message?: string,
  details?: PigChangedDetails | AttemptInFlightDetails | RetryDetails
): NextResponse<ApiError> {
  const error = message ?? ERROR_MESSAGES[code]
  let body: ApiError
  let retryAfter: number | null = null
  if (code === 'pig_changed') {
    const { pigEpoch, level } = details as PigChangedDetails
    body = { error, code, pigEpoch, level }
  } else if (code === 'attempt_in_flight') {
    const { sameKey, retryAfterSeconds } = details as AttemptInFlightDetails
    retryAfter = clampRetryAfterSeconds(retryAfterSeconds)
    body = { error, code, sameKey, retryAfterSeconds: retryAfter }
  } else {
    const seconds = (details as RetryDetails | undefined)?.retryAfterSeconds
    if (typeof seconds === 'number') retryAfter = clampRetryAfterSeconds(seconds)
    body = { error, code }
  }
  const headers: Record<string, string> = { 'cache-control': NO_STORE }
  if (retryAfter !== null) headers['retry-after'] = String(retryAfter)
  return NextResponse.json(body, { status, headers })
}

// ---------------------------------------------------------------------------
// Database errors

/** What a route needs from a database error. */
export type RpcErrorMapping = {
  status: number
  body: ApiError
  /** Seconds for the Retry-After header, or null. */
  retryAfterSeconds: number | null
  /** True for server bugs (invariant_violation and internal), which the route logs at error level. */
  log: boolean
  /**
   * Safe fields for that log line: the SQLSTATE and the recognized token
   * only. Never log the raw error: its message, details, and hint can hold
   * row values, including prompts (T25).
   */
  logContext: { sqlstate: string | null; token: string | null }
}

/** The action a 402 refers to, for its message. */
export type FundsAction = 'attack' | 'repair' | 'donate'

export type MapRpcErrorOptions = {
  action?: FundsAction
  /** The clock for the daily_cap fallback; tests inject it. */
  now?: Date
}

const PT409_TOKENS = [
  'attempt_in_flight',
  'already_finalized',
  'pig_changed',
  'nothing_to_repair',
  'stale_parent',
] as const satisfies readonly ErrorCode[]
const PT422_TOKENS = ['invalid_amount', 'invariant_violation'] as const satisfies readonly ErrorCode[]
const PT429_TOKENS = ['rate_limited', 'daily_cap'] as const satisfies readonly ErrorCode[]
/** `spend_cap` is the SQL token for the spend_cap_reached code (R3-N3). */
const PT503_TOKENS = {
  kill_switch: 'kill_switch',
  spend_cap: 'spend_cap_reached',
  spend_cap_reached: 'spend_cap_reached',
  level_not_configured: 'level_not_configured',
  unavailable: 'unavailable',
} as const satisfies Record<string, ErrorCode>

/** The Postgres default name of `unique (user_id, idempotency_key)` on public.attempts. */
const ATTEMPT_KEY_CONSTRAINT = 'attempts_user_idempotency_key'

const DEFAULT_IN_FLIGHT_RETRY_SECONDS = 5
const MAX_IN_FLIGHT_RETRY_SECONDS = 300
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 10

/** Error messages thrown by src/lib/supabase when its environment is missing (PP-01). */
const SUPABASE_NOT_CONFIGURED = /^Supabase (?:admin client )?is not configured\b/

type ErrorFields = { code: string | null; message: string; details: string; hint: string; name: string }

function fieldsOf(error: unknown): ErrorFields {
  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  return {
    code: typeof record.code === 'string' && record.code !== '' ? record.code : null,
    message: text(record.message),
    details: text(record.details),
    hint: text(record.hint),
    name: text(record.name),
  }
}

/** The first word of the message that is one of the allowed tokens. */
function tokenIn<T extends string>(message: string, allowed: readonly T[]): T | null {
  for (const word of message.toLowerCase().match(/[a-z_]+/g) ?? []) {
    if ((allowed as readonly string[]).includes(word)) return word as T
  }
  return null
}

function parseHintObject(hint: string): Record<string, unknown> | null {
  if (hint.trim() === '') return null
  try {
    const value: unknown = JSON.parse(hint)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** pig_changed: `{ pigEpoch, level }`, or pigEpoch 0 ("unknown, refetch") and level 1. */
export function parsePigChangedHint(hint: string): PigChangedDetails {
  const parsed = parseHintObject(hint)
  const pigEpoch = safeInteger(parsed?.pigEpoch)
  const level = parsed?.level
  if (pigEpoch === null || pigEpoch < 1 || !isLevelId(level)) return { pigEpoch: 0, level: 1 }
  return { pigEpoch, level: level as LevelId }
}

/**
 * attempt_in_flight: `{ sameKey, retryAfterSeconds }`, with the seconds
 * clamped to 1..300 so a client never retries at once (R3-06). A malformed
 * hint gives sameKey false, so the client waits instead of re-posting.
 */
export function parseAttemptInFlightHint(hint: string): AttemptInFlightDetails {
  const parsed = parseHintObject(hint)
  if (!parsed || typeof parsed.sameKey !== 'boolean') {
    return { sameKey: false, retryAfterSeconds: DEFAULT_IN_FLIGHT_RETRY_SECONDS }
  }
  const raw = parsed.retryAfterSeconds
  const seconds =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.ceil(raw) : DEFAULT_IN_FLIGHT_RETRY_SECONDS
  return {
    sameKey: parsed.sameKey,
    retryAfterSeconds: Math.min(MAX_IN_FLIGHT_RETRY_SECONDS, Math.max(1, seconds)),
  }
}

/** insufficient_funds: `{ balanceCents, priceCents }` (snake_case accepted), or null. */
export function parseFundsHint(hint: string): { balanceCents: number; priceCents: number } | null {
  const parsed = parseHintObject(hint)
  if (!parsed) return null
  const balanceCents = safeInteger(parsed.balanceCents ?? parsed.balance_cents)
  const priceCents = safeInteger(parsed.priceCents ?? parsed.price_cents)
  if (balanceCents === null || priceCents === null || priceCents < 1) return null
  return { balanceCents, priceCents }
}

/** Seconds from a rate-limit hint: a bare number or `{ retryAfterSeconds }`. */
export function parseRetryHint(hint: string): number | null {
  const trimmed = hint.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return clampRetryAfterSeconds(Number(trimmed))
  const parsed = parseHintObject(trimmed)
  const raw = parsed?.retryAfterSeconds
  return typeof raw === 'number' && Number.isFinite(raw) ? clampRetryAfterSeconds(raw) : null
}

function secondsUntilNextUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return clampRetryAfterSeconds((next - now.getTime()) / 1000)
}

function fundsMessage(hint: string, action: FundsAction | undefined): string {
  const funds = parseFundsHint(hint)
  if (!funds) return ERROR_MESSAGES.insufficient_funds
  const purpose = action ? ` to ${action}` : ''
  return `You need ${formatCents(funds.priceCents)}${purpose}. Your wallet has ${formatCents(funds.balanceCents)}.`
}

function plain(
  code: PlainErrorCode,
  sqlstate: string | null,
  token: string | null,
  options: { message?: string; retryAfterSeconds?: number | null } = {}
): RpcErrorMapping {
  return {
    status: ERROR_STATUS[code],
    body: { error: options.message ?? ERROR_MESSAGES[code], code },
    retryAfterSeconds: options.retryAfterSeconds ?? null,
    log: code === 'invariant_violation' || code === 'internal',
    logContext: { sqlstate, token },
  }
}

/**
 * Maps a Supabase/PostgREST error (or anything thrown around an RPC call) to
 * an API error, following every row of the section 7 error table:
 *
 * - PT402 -> 402 insufficient_funds, with the balance and price from the hint.
 * - PT403 -> 403 forbidden.
 * - PT409 -> 409 attempt_in_flight, already_finalized, pig_changed,
 *   nothing_to_repair, or stale_parent, chosen by the message token;
 *   pig_changed and attempt_in_flight carry their hint fields.
 * - PT422 -> 422 invalid_amount, or invariant_violation for any other token.
 * - PT429 -> 429 rate_limited or daily_cap, with Retry-After from the hint.
 * - PT503 -> 503 kill_switch, spend_cap_reached (SQL token spend_cap),
 *   level_not_configured, or unavailable for any other token.
 * - 23505 on attempts (user_id, idempotency_key) -> 409 attempt_in_flight
 *   with sameKey true, the backstop for two requests with one key.
 * - A missing Supabase or server environment -> 503 unavailable.
 * - Anything else -> 500 internal, with no internals in the message.
 */
export function mapRpcError(error: unknown, options: MapRpcErrorOptions = {}): RpcErrorMapping {
  const { code: sqlstate, message, details, hint, name } = fieldsOf(error)

  switch (sqlstate) {
    case 'PT402':
      return plain('insufficient_funds', sqlstate, 'insufficient_funds', {
        message: fundsMessage(hint, options.action),
      })
    case 'PT403':
      return plain('forbidden', sqlstate, tokenIn(message, ['forbidden']))
    case 'PT409': {
      const token = tokenIn(message, PT409_TOKENS)
      if (token === 'pig_changed') {
        const fields = parsePigChangedHint(hint)
        return {
          status: ERROR_STATUS.pig_changed,
          body: { error: ERROR_MESSAGES.pig_changed, code: 'pig_changed', ...fields },
          retryAfterSeconds: null,
          log: false,
          logContext: { sqlstate, token },
        }
      }
      if (token === 'attempt_in_flight') return inFlight(parseAttemptInFlightHint(hint), sqlstate, token)
      if (token) return plain(token, sqlstate, token)
      return plain('internal', sqlstate, null)
    }
    case 'PT422': {
      const token = tokenIn(message, PT422_TOKENS)
      return plain(token ?? 'invariant_violation', sqlstate, token)
    }
    case 'PT429': {
      const token = tokenIn(message, PT429_TOKENS) ?? 'rate_limited'
      const fromHint = parseRetryHint(hint)
      const retryAfterSeconds =
        fromHint ??
        (token === 'daily_cap'
          ? secondsUntilNextUtcMidnight(options.now ?? new Date())
          : DEFAULT_RATE_LIMIT_RETRY_SECONDS)
      return plain(token, sqlstate, token, { retryAfterSeconds })
    }
    case 'PT503': {
      const word = tokenIn(message, Object.keys(PT503_TOKENS) as (keyof typeof PT503_TOKENS)[])
      return plain(word ? PT503_TOKENS[word] : 'unavailable', sqlstate, word)
    }
    case '23505':
      if (message.includes(ATTEMPT_KEY_CONSTRAINT) || /\(user_id, idempotency_key\)/.test(details)) {
        return inFlight({ sameKey: true, retryAfterSeconds: 1 }, sqlstate, 'attempts_idempotency_key')
      }
      return plain('internal', sqlstate, null)
    default:
      break
  }

  if (name === 'ServerEnvError' || name === 'PublicEnvError' || SUPABASE_NOT_CONFIGURED.test(message)) {
    return plain('unavailable', sqlstate, 'environment')
  }
  return plain('internal', sqlstate, null)
}

function inFlight(details: AttemptInFlightDetails, sqlstate: string | null, token: string): RpcErrorMapping {
  return {
    status: ERROR_STATUS.attempt_in_flight,
    body: {
      error: details.sameKey ? SAME_KEY_IN_FLIGHT_MESSAGE : ERROR_MESSAGES.attempt_in_flight,
      code: 'attempt_in_flight',
      ...details,
    },
    retryAfterSeconds: details.retryAfterSeconds,
    log: false,
    logContext: { sqlstate, token },
  }
}

/** Turns a mapping from mapRpcError() into the response. */
export function errorResponse(mapping: RpcErrorMapping): NextResponse<ApiError> {
  const { body, status } = mapping
  if (body.code === 'pig_changed') {
    return jsonError('pig_changed', status, body.error, { pigEpoch: body.pigEpoch, level: body.level })
  }
  if (body.code === 'attempt_in_flight') {
    return jsonError('attempt_in_flight', status, body.error, {
      sameKey: body.sameKey,
      retryAfterSeconds: body.retryAfterSeconds,
    })
  }
  return jsonError(body.code, status, body.error, { retryAfterSeconds: mapping.retryAfterSeconds })
}
