import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'
import { requirePublicSupabaseEnv } from '@/lib/supabase/env'

/**
 * Supabase client for Client Components. It uses the publishable (anon) key,
 * so every query is bound by row-level security. `createBrowserClient` keeps one instance per
 * page, so calling this repeatedly is cheap.
 */
export function createClient() {
  const { url, publishableKey } = requirePublicSupabaseEnv()
  return createBrowserClient<Database>(url, publishableKey)
}
