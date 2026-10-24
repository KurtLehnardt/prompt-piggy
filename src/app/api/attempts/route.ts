import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUserApi } from '@/lib/auth/require-user'
import { errorResponse, jsonError, mapRpcError } from '@/lib/errors'
import { performAttempt } from '@/lib/game/attempt-service'
import { assertSameOrigin } from '@/lib/http/origin'
import { isKilledByEnv } from '@/lib/ops/kill-switch'
import { getLimits } from '@/lib/ops/limits'
import { attemptRequestSchema, type AttemptResponseDTO } from '@/types/api'

/**
 * POST /api/attempts (docs/ARCHITECTURE.md sections 3 and 7; HC-A4; CH-1;
 * REVIEW-2 R2-05, R2-13, R2-S3; PR #6 review, M5; T13, T16, T20, T25).
 *
 * 1. requireUserApi() asks the Auth server (getUser()); a signed-out or
 *    anonymous user gets 401.
 * 2. A foreign or missing Origin gets 403 `forbidden`.
 * 3. The body is a zod strictObject `{ message, idempotencyKey,
 *    expectedEpoch }` with the configured MAX_PROMPT_CHARS; unknown keys,
 *    malformed JSON, and oversized bodies get 400. The user id comes from
 *    getUser() only, and the client never chooses the level, the price, or
 *    the outcome.
 * 4. PIGGY_KILL_SWITCH answers 503 `kill_switch` before anything is charged.
 * 5. The attempt service (src/lib/game/attempt-service.ts) runs the rest: the
 *    $1 debit, the Dynamic Validator, the Core LLM, the Evaluator, and the
 *    settlement. Its after-response work (the hardening hook for a paid win
 *    and the sweep) is handed to after().
 *
 * A system error during the attempt is not an HTTP error: it is a 200 with
 * outcome `error` and the refund. There is no GET /api/attempts/[id]; a
 * client that lost a response re-posts the same idempotency key (R2-S3).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Must equal ATTEMPT_MAX_DURATION_S (src/lib/ops/limits.ts); route.test.ts checks it.
export const maxDuration = 30

/** A body larger than this is refused before it is parsed. The message itself is at most 4,000 characters. */
const MAX_BODY_BYTES = 32 * 1024

async function readJson(request: NextRequest): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false }
  try {
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return { ok: false }
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false }
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireUserApi()
  if (!auth.ok) return auth.response

  if (!assertSameOrigin(request)) return jsonError('forbidden', 403)

  let maxPromptChars: number
  try {
    maxPromptChars = getLimits().maxPromptChars
  } catch (error) {
    return errorResponse(mapRpcError(error))
  }

  const json = await readJson(request)
  if (!json.ok) return jsonError('invalid_request', 400)
  const body = attemptRequestSchema(maxPromptChars).safeParse(json.value)
  if (!body.success) return jsonError('invalid_request', 400)

  if (isKilledByEnv()) return jsonError('kill_switch', 503)

  const result = await performAttempt({
    userId: auth.user.id,
    message: body.data.message,
    idempotencyKey: body.data.idempotencyKey,
    expectedEpoch: body.data.expectedEpoch,
  })
  after(result.afterResponse)

  if (result.kind === 'error') return errorResponse(result.mapping)
  const payload: AttemptResponseDTO = { attempt: result.attempt }
  return NextResponse.json(payload, { headers: { 'cache-control': 'no-store' } })
}
