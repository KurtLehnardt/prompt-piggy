import { formatCents } from '@/lib/money/format'
import {
  ApiErrorSchema,
  AttemptResponseSchema,
  DonateResultSchema,
  RepairResultSchema,
  type ApiError,
  type AttemptResultDTO,
  type DonateResultDTO,
  type RepairResultDTO,
} from '@/types/api'

/**
 * The browser client for the game's money routes (docs/ARCHITECTURE.md
 * section 7; R2-05, R2-20, R2-S3).
 *
 * - Every submission gets one idempotency key from crypto.randomUUID(), and
 *   every retry of that submission re-posts the same key, so a lost response
 *   never charges twice: the server answers a repeated key with the stored
 *   result.
 * - A network error, a timeout, a gateway error without a JSON body, and,
 *   for attempts, 409 attempt_in_flight with sameKey true are retried with a
 *   backoff of 1, 2, 4, 8, and 16 seconds, stopping after about 45 seconds.
 * - There is no GET by id: re-posting the key is the only recovery path.
 * - Every body is parsed with the zod schemas of src/types/api.ts. A body
 *   that does not parse never reaches the UI.
 *
 * The module holds no state and computes no money: every amount it returns
 * comes from the server.
 */

export const ATTEMPTS_URL = '/api/attempts'
export const REPAIR_URL = '/api/wallet/repair'
export const DONATE_URL = '/api/wallet/donate'

/** Backoff between retries of one submission (R2-05). */
export const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000] as const)

/** Retries stop once this much time has passed since the first failure. */
export const RETRY_WINDOW_MS = 45_000

/**
 * One attempt request may run for the route's maxDuration of 30 seconds, so
 * the client waits a little longer before it treats the request as lost.
 */
export const ATTEMPT_REQUEST_TIMEOUT_MS = 35_000

/** The wallet routes make one short SQL call. */
export const WALLET_REQUEST_TIMEOUT_MS = 15_000

export type ApiClientDeps = {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  randomUUID?: () => string
}

/** An error answer from the server, parsed. */
export type ApiFailure = {
  kind: 'error'
  status: number
  error: ApiError
  /** Seconds from the Retry-After header or the body, or null. */
  retryAfterSeconds: number | null
}

/** Every retry failed or the retry window ran out. The submission may still finish on the server. */
export type Unreachable = { kind: 'unreachable' }

export type AttemptCallResult =
  | { kind: 'ok'; attempt: AttemptResultDTO; idempotencyKey: string }
  /** POST /api/attempts answered 404: the attempt route is not deployed yet. */
  | { kind: 'not_open'; idempotencyKey: string }
  | (ApiFailure & { idempotencyKey: string })
  | (Unreachable & { idempotencyKey: string })

export type RepairCallResult = { kind: 'ok'; result: RepairResultDTO } | ApiFailure | Unreachable
export type DonateCallResult = { kind: 'ok'; result: DonateResultDTO } | ApiFailure | Unreachable

export const UNREACHABLE_MESSAGE =
  'We lost touch with the server. If your attack went through, it shows up under Me.'

const INTERNAL_ERROR: ApiError = { error: 'Something went wrong.', code: 'internal' }

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A new idempotency key, generated once per submission. */
export function newIdempotencyKey(deps: ApiClientDeps = {}): string {
  return deps.randomUUID ? deps.randomUUID() : crypto.randomUUID()
}

function retryAfterFrom(headers: Headers, error: ApiError | null): number | null {
  if (error?.code === 'attempt_in_flight') return error.retryAfterSeconds
  const header = headers.get('retry-after')
  if (header === null || !/^\d+$/.test(header.trim())) return null
  const seconds = Number(header.trim())
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null
}

type SendOutcome =
  | { type: 'response'; status: number; headers: Headers; body: unknown; isJson: boolean }
  | { type: 'lost' }

async function sendOnce(url: string, payload: unknown, timeoutMs: number, deps: ApiClientDeps): Promise<SendOutcome> {
  const fetchImpl = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
    // The timer also covers reading the body.
    const text = await response.text()
    let body: unknown = null
    let isJson = false
    try {
      body = text === '' ? null : JSON.parse(text)
      isJson = text !== ''
    } catch {
      isJson = false
    }
    return { type: 'response', status: response.status, headers: response.headers, body, isJson }
  } catch {
    // A network error or the abort: the request may or may not have arrived.
    return { type: 'lost' }
  } finally {
    clearTimeout(timer)
  }
}

type Step<T> = { done: true; value: T } | { done: false }

/**
 * Posts `payload` and re-posts the identical payload (same idempotency key)
 * while `interpret` says the answer is retryable, with the R2-05 backoff.
 */
async function postWithRetry<T>(
  url: string,
  payload: unknown,
  timeoutMs: number,
  interpret: (outcome: SendOutcome) => Step<T>,
  onGiveUp: () => T,
  deps: ApiClientDeps
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  let firstFailureAt: number | null = null
  for (let retry = 0; ; retry++) {
    const step = interpret(await sendOnce(url, payload, timeoutMs, deps))
    if (step.done) return step.value
    firstFailureAt ??= now()
    const delay = RETRY_DELAYS_MS[retry]
    if (delay === undefined || now() - firstFailureAt + delay > RETRY_WINDOW_MS) return onGiveUp()
    await sleep(delay)
  }
}

/**
 * Classifies a response that is not a success. A 5xx without a JSON error
 * body is a gateway or platform failure (for example a function timeout), so
 * it is retried like a lost response; every other unparseable error is an
 * internal error.
 */
function failureOf(outcome: Extract<SendOutcome, { type: 'response' }>): ApiFailure | 'retry' {
  const parsed = ApiErrorSchema.safeParse(outcome.body)
  if (!parsed.success) {
    if (outcome.status >= 500) return 'retry'
    return { kind: 'error', status: outcome.status, error: INTERNAL_ERROR, retryAfterSeconds: null }
  }
  return {
    kind: 'error',
    status: outcome.status,
    error: parsed.data,
    retryAfterSeconds: retryAfterFrom(outcome.headers, parsed.data),
  }
}

/**
 * POST /api/attempts. The key is generated here, once, and reused on every
 * retry. On 409 attempt_in_flight with sameKey true the same key is re-posted
 * until the stored DTO arrives; sameKey false is returned to the caller, which
 * re-enables Send after retryAfterSeconds.
 */
export async function postAttempt(
  input: { message: string; expectedEpoch: number },
  deps: ApiClientDeps = {}
): Promise<AttemptCallResult> {
  const idempotencyKey = newIdempotencyKey(deps)
  const payload = { message: input.message, idempotencyKey, expectedEpoch: input.expectedEpoch }
  return postWithRetry<AttemptCallResult>(
    ATTEMPTS_URL,
    payload,
    ATTEMPT_REQUEST_TIMEOUT_MS,
    (outcome) => {
      if (outcome.type === 'lost') return { done: false }
      if (outcome.status >= 200 && outcome.status < 300) {
        const parsed = AttemptResponseSchema.safeParse(outcome.body)
        if (parsed.success) return { done: true, value: { kind: 'ok', attempt: parsed.data.attempt, idempotencyKey } }
        return {
          done: true,
          value: { kind: 'error', status: outcome.status, error: INTERNAL_ERROR, retryAfterSeconds: null, idempotencyKey },
        }
      }
      // Until the attempt route (PP-26) is deployed, Next.js answers 404.
      if (outcome.status === 404) return { done: true, value: { kind: 'not_open', idempotencyKey } }
      const failure = failureOf(outcome)
      if (failure === 'retry') return { done: false }
      if (failure.error.code === 'attempt_in_flight' && failure.error.sameKey) return { done: false }
      return { done: true, value: { ...failure, idempotencyKey } }
    },
    () => ({ kind: 'unreachable', idempotencyKey }),
    deps
  )
}

function walletInterpret<T extends RepairResultDTO | DonateResultDTO>(
  schema: typeof RepairResultSchema | typeof DonateResultSchema
) {
  return (outcome: SendOutcome): Step<{ kind: 'ok'; result: T } | ApiFailure> => {
    if (outcome.type === 'lost') return { done: false }
    if (outcome.status >= 200 && outcome.status < 300) {
      const parsed = schema.safeParse(outcome.body)
      if (parsed.success) return { done: true, value: { kind: 'ok', result: parsed.data as T } }
      return { done: true, value: { kind: 'error', status: outcome.status, error: INTERNAL_ERROR, retryAfterSeconds: null } }
    }
    const failure = failureOf(outcome)
    if (failure === 'retry') return { done: false }
    return { done: true, value: failure }
  }
}

/** POST /api/wallet/repair with the caller's key, reused on every retry. The price is never sent. */
export async function repair(idempotencyKey: string, deps: ApiClientDeps = {}): Promise<RepairCallResult> {
  return postWithRetry<RepairCallResult>(
    REPAIR_URL,
    { idempotencyKey },
    WALLET_REQUEST_TIMEOUT_MS,
    walletInterpret<RepairResultDTO>(RepairResultSchema),
    () => ({ kind: 'unreachable' }),
    deps
  )
}

/** POST /api/wallet/donate with the caller's key, reused on every retry. */
export async function donate(
  amountCents: number,
  idempotencyKey: string,
  deps: ApiClientDeps = {}
): Promise<DonateCallResult> {
  return postWithRetry<DonateCallResult>(
    DONATE_URL,
    { amountCents, idempotencyKey },
    WALLET_REQUEST_TIMEOUT_MS,
    walletInterpret<DonateResultDTO>(DonateResultSchema),
    () => ({ kind: 'unreachable' }),
    deps
  )
}

// ---------------------------------------------------------------------------
// Player-facing copy for every error code

export const PIG_CHANGED_MESSAGE = 'The pig just leveled up! Review your attack and send again.'
export const OTHER_ATTEMPT_RUNNING_MESSAGE = 'Another attack from your account is still running.'
export const LEVEL_NOT_READY_MESSAGE = 'This level is not ready yet.'

/** A wait in words: "7 seconds", "5 minutes", "3 hours". */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds))
  if (s < 90) return `${s} ${s === 1 ? 'second' : 'seconds'}`
  if (s < 90 * 60) {
    const m = Math.round(s / 60)
    return `${m} minutes`
  }
  const h = Math.round(s / 3600)
  return `${h} ${h === 1 ? 'hour' : 'hours'}`
}

/**
 * The toast text for an error answer. Every ErrorCode has a case, and the
 * `never` check makes a new code a type error until it gets one:
 *
 * - 429 shows the Retry-After seconds.
 * - 503 shows "Vault closed", or "This level is not ready yet." for
 *   level_not_configured.
 * - 402 shows the server's message, which states the balance and the price.
 */
export function errorMessage(failure: Pick<ApiFailure, 'error' | 'retryAfterSeconds'>): string {
  const { error, retryAfterSeconds } = failure
  const code = error.code
  switch (code) {
    case 'invalid_request':
      return 'That request was not valid. Check it and try again.'
    case 'unauthorized':
      return 'Your session ended. Sign in again to keep playing.'
    case 'insufficient_funds':
      return error.error
    case 'forbidden':
      return 'You are not allowed to do that. Reload the page and try again.'
    case 'not_found':
      return 'That was not found.'
    case 'attempt_in_flight':
      return error.sameKey ? 'Your attack is still running. It shows up under Me when it finishes.' : OTHER_ATTEMPT_RUNNING_MESSAGE
    case 'already_finalized':
      return error.error
    case 'pig_changed':
      return PIG_CHANGED_MESSAGE
    case 'nothing_to_repair':
      return 'Your glass has no cracks to repair.'
    case 'stale_parent':
      return 'The rules changed while that was running. Try again.'
    case 'invalid_amount':
      return 'That amount is not valid.'
    case 'invariant_violation':
      return 'Something went wrong. Nothing was changed.'
    case 'rate_limited':
    case 'daily_cap': {
      const base = code === 'rate_limited' ? 'Slow down a little.' : 'You reached the attack limit for today (UTC).'
      return retryAfterSeconds !== null ? `${base} Try again in ${formatWait(retryAfterSeconds)}.` : base
    }
    case 'kill_switch':
      return 'Vault closed. The vault is closed right now.'
    case 'spend_cap_reached':
      return 'Vault closed. The daily budget is used up.'
    case 'unavailable':
      return 'Vault closed. The service is not configured yet.'
    case 'level_not_configured':
      return LEVEL_NOT_READY_MESSAGE
    case 'internal':
      return 'Something went wrong. Try again.'
    default: {
      const unhandled: never = code
      return unhandled
    }
  }
}

/** The text for a finished attempt, from server fields only (HC-A5). */
export function outcomeMessage(
  attempt: Pick<AttemptResultDTO, 'outcome' | 'payoutCents' | 'refundCents' | 'refundWithheld' | 'priceCents'>
): string {
  switch (attempt.outcome) {
    case 'win':
      return `You broke the pig! ${formatCents(attempt.payoutCents)} is yours.`
    case 'late_win':
      return 'Your attack worked, but another player broke this pig first, so there is no payout this time.'
    case 'fail':
      return 'The pig held.'
    case 'blocked':
      return 'The guard stopped that attack before it reached the pig.'
    case 'leak_blocked':
      return 'The pig almost let a secret slip, but the filter caught it.'
    case 'error':
      if (attempt.refundWithheld) {
        return `A system error ended this attack. You reached the refund limit for this hour, so the ${formatCents(attempt.priceCents)} was kept.`
      }
      if (attempt.refundCents > 0) {
        return `A system error ended this attack. ${formatCents(attempt.refundCents)} was refunded.`
      }
      return 'A system error ended this attack.'
  }
}
