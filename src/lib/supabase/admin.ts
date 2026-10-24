import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { resolveSupabaseUrl } from '@/lib/supabase/env'
import { resolveSupabaseSecretKey } from '@/lib/supabase/env.server'

/**
 * Secret-key (service-role) Supabase client. It bypasses row-level security,
 * so it may only be used in server code after the caller has been
 * authenticated and authorized (ARCHITECTURE section 11, T14).
 *
 * It reads SUPABASE_SECRET_KEY, which the Supabase Vercel integration syncs,
 * and falls back to the legacy SUPABASE_SERVICE_ROLE_KEY. It never falls back
 * to the publishable or anon key.
 *
 * `server-only` makes any import from a Client Component a build error, and
 * neither key name has a NEXT_PUBLIC_ prefix, so Next.js never inlines the
 * value into a bundle.
 */
export function createAdminClient() {
  const url = resolveSupabaseUrl()
  const secretKey = resolveSupabaseSecretKey()
  if (!url || !secretKey) {
    throw new Error(
      'Supabase admin client is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY).'
    )
  }

  return createClient<Database>(url.value, secretKey.value, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
