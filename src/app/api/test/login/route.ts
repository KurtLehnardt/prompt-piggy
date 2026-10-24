import { randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { isE2ETestMode } from '@/lib/e2e-helpers'
import { errorResponse, jsonError, mapRpcError } from '@/lib/errors'
import { assertSameOrigin } from '@/lib/http/origin'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveSupabaseUrl } from '@/lib/supabase/env'
import { createClient } from '@/lib/supabase/server'
import { TestLoginSchema } from '@/types/api'

/**
 * Test-only password login for the E2E suite (docs/ARCHITECTURE.md section
 * 1.2 row 5, section 7, and section 11 T23).
 *
 * It answers 404 `not_found`, exactly as if it did not exist, unless both:
 *
 * - isE2ETestMode() is true, which is hard-false whenever NODE_ENV is
 *   production, so every `next build`/`next start` and every Vercel
 *   deployment (previews included) answers 404; and
 * - the Supabase URL points at a local stack (127.0.0.1, localhost, or ::1),
 *   so even a developer running `next dev` in test mode against a hosted
 *   project cannot reach it.
 *
 * Then it also requires a same-origin POST (403 otherwise, PR #6 review M5)
 * and an address in the reserved test domain @e2e.prompt-piggy.test (403
 * otherwise), so it can never sign in as a real or Google account. Such a
 * user signs up with the email provider, so it can never be an admin either
 * (require-admin.ts demands the Google provider).
 *
 * It creates the user if needed, gives it a fresh random password with the
 * service-role client, and signs in with that password through the
 * cookie-bound server client, so the response sets the normal session
 * cookies. No password is ever stored, logged, or returned. It never bypasses
 * auth: every page and route still checks the real session.
 *
 * Callers (the E2E fixtures) POST `{ "email": "<name>@e2e.prompt-piggy.test" }`
 * with an `Origin` header equal to the app origin.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TEST_EMAIL_DOMAIN = 'e2e.prompt-piggy.test'

const LOCAL_SUPABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LIST_USERS_PAGE_SIZE = 1000
const LIST_USERS_MAX_PAGES = 20
const NO_STORE = 'private, no-cache, no-store, must-revalidate, max-age=0'

type AdminClient = ReturnType<typeof createAdminClient>

/** True only when the configured Supabase URL is a local stack. */
function usesLocalSupabase(): boolean {
  const configured = resolveSupabaseUrl()
  if (!configured) return false
  try {
    const url = new URL(configured.value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_SUPABASE_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function isAvailable(): boolean {
  return isE2ETestMode() && usesLocalSupabase()
}

function isEmailTaken(error: { code?: string; status?: number }): boolean {
  return error.code === 'email_exists' || error.status === 422
}

async function findUserIdByEmail(admin: AdminClient, email: string): Promise<string | null> {
  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE })
    if (error) throw error
    const match = data.users.find((user) => user.email?.toLowerCase() === email)
    if (match) return match.id
    if (data.users.length < LIST_USERS_PAGE_SIZE) return null
  }
  return null
}

/** Creates the confirmed password user, or resets the password of the existing one. */
async function preparePasswordUser(admin: AdminClient, email: string, password: string): Promise<void> {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (!created.error) return
  if (!isEmailTaken(created.error)) throw created.error

  const id = await findUserIdByEmail(admin, email)
  if (!id) throw new Error('The existing test user could not be found.')
  const updated = await admin.auth.admin.updateUserById(id, { password })
  if (updated.error) throw updated.error
}

export async function POST(request: NextRequest) {
  if (!isAvailable()) return jsonError('not_found', 404)
  if (!assertSameOrigin(request)) return jsonError('forbidden', 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('invalid_request', 400)
  }
  const parsed = TestLoginSchema.safeParse(body)
  if (!parsed.success) return jsonError('invalid_request', 400)

  const email = parsed.data.email.trim().toLowerCase()
  if (!email.endsWith(`@${TEST_EMAIL_DOMAIN}`)) {
    return jsonError('forbidden', 403, `The test login accepts only @${TEST_EMAIL_DOMAIN} addresses.`)
  }

  try {
    const password = randomBytes(32).toString('base64url')
    await preparePasswordUser(createAdminClient(), email, password)

    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error || !data.user) {
      console.error('Test login could not sign in:', error?.code ?? 'no user returned')
      return jsonError('internal', 500)
    }
    return NextResponse.json({ ok: true, userId: data.user.id }, { headers: { 'cache-control': NO_STORE } })
  } catch (error) {
    const mapping = mapRpcError(error)
    if (mapping.log) console.error('Test login failed:', mapping.logContext)
    return errorResponse(mapping)
  }
}

/** Only POST signs in. Every other request gets the same 404 as outside test mode. */
export function GET() {
  return jsonError('not_found', 404)
}
