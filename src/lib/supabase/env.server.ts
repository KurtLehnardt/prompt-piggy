import 'server-only'
import { firstSet } from '@/lib/supabase/env'

/**
 * The Supabase secret key, which bypasses row-level security.
 *
 * It reads SUPABASE_SECRET_KEY, which the Supabase Vercel integration syncs,
 * then the legacy SUPABASE_SERVICE_ROLE_KEY from ARCHITECTURE section 13. It
 * is read when called, never when the module is imported.
 *
 * `server-only` makes any import from a Client Component a build error. That
 * matters even though neither name has a NEXT_PUBLIC_ prefix: a Client
 * Component that called this during server rendering or prerendering would put
 * the value into the HTML sent to the browser (REVIEW-PR2-r2 P2R-02).
 * secret-key-boundary.test.ts checks that this is the only module that reads
 * either variable and that no client module can reach it.
 *
 * Only the admin client and the health page call it. The health page shows the
 * variable name, never the value.
 */
export function resolveSupabaseSecretKey() {
  return firstSet([
    ['SUPABASE_SECRET_KEY', process.env.SUPABASE_SECRET_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
  ] as const)
}
