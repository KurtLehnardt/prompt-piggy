import 'server-only'
import type { User } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import type { NextResponse } from 'next/server'
import { errorResponse, jsonError, mapRpcError } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import type { ApiError } from '@/types/api'

/**
 * The user checks for pages and API routes (docs/ARCHITECTURE.md section 7;
 * REVIEW-2 R2-16; threat T27).
 *
 * - Both use supabase.auth.getUser(), which asks the Auth server, so a revoked
 *   or forged session never counts. getClaims() is not enough here: with
 *   asymmetric signing keys it checks the token locally and cannot see a
 *   sign-out on another device.
 * - An anonymous user (`is_anonymous: true`) counts as signed out. Anonymous
 *   sign-ins are disabled, but anonymous users carry the `authenticated`
 *   Postgres role, so this keeps them out even if the setting is ever flipped.
 * - Any error, including a network failure, counts as signed out (fail
 *   closed).
 *
 * Every helper takes an optional client so tests can inject a fake. Without
 * one it creates the cookie-bound server client for the current request.
 */

/** The cookie-bound server client from src/lib/supabase/server.ts. */
export type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

/** The part of a Supabase client these helpers call. */
export type AuthClient = {
  auth: {
    getUser(): Promise<{ data: { user: User | null }; error: unknown }>
  }
}

export type SignedIn<C extends AuthClient> = { user: User; supabase: C }

export type ApiAuthResult<C extends AuthClient> =
  | ({ ok: true } & SignedIn<C>)
  | { ok: false; response: NextResponse<ApiError> }

/** Where a signed-out visitor to a page is sent. */
export const LOGIN_REDIRECT_PATH = '/login'

/**
 * Returns the signed-in, non-anonymous user, or null. Never throws.
 */
export async function getSignedInUser(client: AuthClient): Promise<User | null> {
  try {
    const { data, error } = await client.auth.getUser()
    const user = data?.user
    if (error || !user) return null
    if (typeof user.id !== 'string' || user.id === '') return null
    if (user.is_anonymous === true) return null
    return user
  } catch {
    return null
  }
}

/**
 * For public pages that only change what they show, such as the landing
 * page: the signed-in user, or null when signed out or when Supabase is not
 * configured. Never throws and never redirects.
 */
export async function getCurrentUser(client?: AuthClient): Promise<User | null> {
  try {
    return await getSignedInUser(client ?? (await createClient()))
  } catch {
    return null
  }
}

/**
 * For Server Components and layouts: returns the user and the client, or
 * redirects to /login. The redirect throws, so code after the call only runs
 * for a signed-in user.
 */
export async function requireUserPage<C extends AuthClient = ServerSupabaseClient>(
  client?: C
): Promise<SignedIn<C>> {
  const supabase = (client ?? (await createClient())) as C
  const user = await getSignedInUser(supabase)
  if (!user) redirect(LOGIN_REDIRECT_PATH)
  return { user, supabase }
}

/**
 * For route handlers: returns the user and the client, or the response to
 * return at once: 401 `unauthorized` for a signed-out or anonymous user, and
 * 503 `unavailable` when Supabase is not configured.
 */
export async function requireUserApi<C extends AuthClient = ServerSupabaseClient>(
  client?: C
): Promise<ApiAuthResult<C>> {
  let supabase: C
  try {
    supabase = (client ?? (await createClient())) as C
  } catch (error) {
    return { ok: false, response: errorResponse(mapRpcError(error)) }
  }
  const user = await getSignedInUser(supabase)
  if (!user) return { ok: false, response: jsonError('unauthorized', 401) }
  return { ok: true, user, supabase }
}
