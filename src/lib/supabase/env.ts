/**
 * Public Supabase settings, read when a client is created and never when a
 * module is imported (REVIEW-1 R1-14). A fresh Vercel import therefore builds
 * before any environment variable is configured.
 *
 * Every setting accepts the name that the Supabase Vercel integration syncs
 * first, then the legacy name from ARCHITECTURE section 13:
 *
 * - URL: NEXT_PUBLIC_SUPABASE_URL
 * - Publishable key: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * Each variable is read with a literal `process.env.NAME` expression, because
 * that is the only form Next.js inlines into the browser bundle.
 *
 * This module is imported by the browser client, so it holds public settings
 * only. The secret key is read in env.server.ts, which is `server-only`.
 * secret-key-boundary.test.ts fails if this file ever names it.
 */

/** A resolved setting: its value and the name of the variable it came from. */
export type ResolvedSetting<Name extends string> = { name: Name; value: string }

/** Returns the first candidate with a non-empty value. */
export function firstSet<Name extends string>(
  candidates: readonly (readonly [Name, string | undefined])[]
): ResolvedSetting<Name> | null {
  for (const [name, value] of candidates) {
    if (value) return { name, value }
  }
  return null
}

export function resolveSupabaseUrl() {
  return firstSet([['NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL]] as const)
}

export function resolveSupabasePublishableKey() {
  return firstSet([
    ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY],
  ] as const)
}

export type PublicSupabaseEnv = {
  url: string
  publishableKey: string
}

const PUBLIC_REQUIREMENT =
  'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY)'

/** Returns the public Supabase settings, or null when either one is unset. */
export function readPublicSupabaseEnv(): PublicSupabaseEnv | null {
  const url = resolveSupabaseUrl()
  const publishableKey = resolveSupabasePublishableKey()
  if (!url || !publishableKey) return null
  return { url: url.value, publishableKey: publishableKey.value }
}

/**
 * Names the public settings that are missing, for log messages. Never returns
 * a value.
 */
export function missingPublicSupabaseEnv(): string[] {
  const missing: string[] = []
  if (!resolveSupabaseUrl()) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!resolveSupabasePublishableKey()) {
    missing.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)')
  }
  return missing
}

/** Returns the public Supabase settings, or throws a clear error naming the missing variables. */
export function requirePublicSupabaseEnv(): PublicSupabaseEnv {
  const env = readPublicSupabaseEnv()
  if (!env) {
    throw new Error(`Supabase is not configured: set ${PUBLIC_REQUIREMENT}.`)
  }
  return env
}
