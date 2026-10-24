import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { requirePublicSupabaseEnv } from '@/lib/supabase/env'

/**
 * Cookie-less Supabase client for public, CDN-cached routes such as
 * /api/live/snapshot and /api/health (REVIEW-1 R1-24a).
 *
 * It never reads or writes cookies and never holds a session, so it always
 * acts as the `anon` role and a cached response can never carry one player's
 * data or session to another.
 */
export function createAnonClient() {
  const { url, anonKey } = requirePublicSupabaseEnv()
  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
