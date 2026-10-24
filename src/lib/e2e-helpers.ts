import 'server-only'

/**
 * The single source of truth for end-to-end test mode (ARCHITECTURE section
 * 1.2, row 5; threat T23).
 *
 * Test mode enables two things and nothing else:
 *
 * - the fake OpenAI models in src/lib/ai/testing/, and
 * - the local-only password login at /api/test/login, which returns 404
 *   whenever this function returns false.
 *
 * It NEVER bypasses authentication. Every page and route still requires a real
 * Supabase session; in test mode that session belongs to a local password
 * user instead of a Google user. Unlike skylite's helper, this module exports
 * no mock user, mock client, or mock data.
 *
 * It is hard-false in production builds. `next build` and `next start` run
 * with NODE_ENV=production, and so does every Vercel deployment, previews
 * included, so a leaked or copied E2E_TEST_MODE variable can never turn test
 * mode on there. Playwright runs against `next dev` (NODE_ENV=development).
 *
 * Only the exact string "true" turns it on. The variable is read on every call,
 * never at import time, and the module is server-only, because the variable is
 * not public and a client bundle could never see it.
 */
export function isE2ETestMode(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.E2E_TEST_MODE === 'true'
}
