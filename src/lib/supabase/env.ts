/**
 * Public Supabase settings, read when a client is created and never when a
 * module is imported (REVIEW-1 R1-14). A fresh Vercel import therefore builds
 * before any environment variable is configured.
 *
 * Each variable is read with a literal `process.env.NAME` expression, because
 * that is the only form Next.js inlines into the browser bundle.
 */
export type PublicSupabaseEnv = {
  url: string
  anonKey: string
}

/** Returns the public Supabase settings, or null when either one is unset. */
export function readPublicSupabaseEnv(): PublicSupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return { url, anonKey }
}

/** Returns the public Supabase settings, or throws a clear error naming the missing variables. */
export function requirePublicSupabaseEnv(): PublicSupabaseEnv {
  const env = readPublicSupabaseEnv()
  if (!env) {
    throw new Error(
      'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.'
    )
  }
  return env
}
