import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { requirePublicSupabaseEnv } from '@/lib/supabase/env'

/**
 * Supabase client for Server Components, Server Functions, and Route Handlers.
 * It reads and writes the session cookies of the current request, so create a
 * new one per request and never share it between requests.
 */
export async function createClient() {
  const { url, publishableKey } = requirePublicSupabaseEnv()
  const cookieStore = await cookies()

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          // setAll was called from a Server Component, which cannot write
          // cookies. This is safe to ignore because src/proxy.ts refreshes the
          // session and writes the cookies on every matched request.
        }
      },
    },
  })
}
