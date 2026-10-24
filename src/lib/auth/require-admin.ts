import 'server-only'
import type { User } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { jsonError } from '@/lib/errors'
import { getEnv } from '@/lib/env'
import {
  requireUserApi,
  requireUserPage,
  type ApiAuthResult,
  type AuthClient,
  type ServerSupabaseClient,
  type SignedIn,
} from '@/lib/auth/require-user'

/**
 * Admin identity (docs/ARCHITECTURE.md section 11, T21; CH-7; REVIEW-2
 * R2-16). There is no admin flag in the database. An admin is a signed-in,
 * non-anonymous user who:
 *
 * - has an email that, trimmed and lowercased, is listed in ADMIN_EMAILS,
 * - signed up with Google (`app_metadata.provider === 'google'`), and
 * - has a confirmed email (`email_confirmed_at` is set).
 *
 * `app_metadata` is writable only with the service role, unlike the
 * user-editable `user_metadata`, so a player cannot grant themselves the
 * provider. An unset or empty ADMIN_EMAILS admits no one, and so does a server
 * environment that fails to parse. No email is hardcoded anywhere.
 */

/** Where a signed-in non-admin is sent by the page helper. */
export const NON_ADMIN_REDIRECT_PATH = '/play'

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email === '' ? null : email
}

/**
 * The admin emails from ADMIN_EMAILS (already trimmed, lowercased, and
 * deduplicated by getEnv()), or an empty list when the environment cannot be
 * read. Fails closed.
 */
export function configuredAdminEmails(): readonly string[] {
  try {
    return getEnv().ADMIN_EMAILS
  } catch (error) {
    // ServerEnvError messages list variable names only, never values.
    console.error(
      'Admin access is closed:',
      error instanceof Error && error.name === 'ServerEnvError' ? error.message : 'the server environment could not be read.'
    )
    return []
  }
}

/** True only when `user` meets every rule above for `adminEmails`. */
export function isAdminUser(user: User | null | undefined, adminEmails: readonly string[]): boolean {
  if (!user || user.is_anonymous === true) return false

  const allowed = new Set(adminEmails.map(normalizeEmail).filter((email): email is string => email !== null))
  if (allowed.size === 0) return false

  const email = normalizeEmail(user.email)
  if (email === null || !allowed.has(email)) return false

  if (user.app_metadata?.provider !== 'google') return false

  const confirmedAt = user.email_confirmed_at
  if (typeof confirmedAt !== 'string' || confirmedAt === '' || Number.isNaN(Date.parse(confirmedAt))) {
    return false
  }
  return true
}

export type AdminCheckOptions<C extends AuthClient> = {
  client?: C
  /** Tests inject the list; routes and pages read ADMIN_EMAILS. */
  adminEmails?: readonly string[]
}

/**
 * For admin pages: returns the admin and the client. A signed-out visitor is
 * redirected to /login and a signed-in non-admin to /play.
 */
export async function requireAdminPage<C extends AuthClient = ServerSupabaseClient>(
  options: AdminCheckOptions<C> = {}
): Promise<SignedIn<C>> {
  const signedIn = await requireUserPage<C>(options.client)
  if (!isAdminUser(signedIn.user, options.adminEmails ?? configuredAdminEmails())) {
    redirect(NON_ADMIN_REDIRECT_PATH)
  }
  return signedIn
}

/**
 * For admin route handlers: returns the admin and the client, or the response
 * to return at once: 401 for a signed-out visitor, 403 `forbidden` for a
 * signed-in non-admin, and 503 when Supabase is not configured.
 */
export async function requireAdminApi<C extends AuthClient = ServerSupabaseClient>(
  options: AdminCheckOptions<C> = {}
): Promise<ApiAuthResult<C>> {
  const result = await requireUserApi<C>(options.client)
  if (!result.ok) return result
  if (!isAdminUser(result.user, options.adminEmails ?? configuredAdminEmails())) {
    return { ok: false, response: jsonError('forbidden', 403) }
  }
  return result
}
