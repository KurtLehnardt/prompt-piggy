import { NextResponse, type NextRequest } from 'next/server'
import { safeRedirect } from '@/lib/auth/safe-redirect'
import { createClient } from '@/lib/supabase/server'

/**
 * OAuth callback (docs/ARCHITECTURE.md section 1.2 row 6, section 7, and
 * section 11 T17). Supabase sends the browser here after Google sign-in with
 * a one-time `code`. The route exchanges it for a session, which
 * @supabase/ssr writes into cookies through the server client, and then
 * redirects:
 *
 * - on success, to safeRedirect(next): this request's origin plus a
 *   validated pathname and search, or /play;
 * - on any failure (no code, a rejected or expired code, a missing PKCE
 *   verifier, Supabase unreachable or not configured), to /auth/error.
 *
 * Skylite forwards `next` unchecked; this route validates it even though the
 * proxy only ever puts a same-origin path there, because anyone can link to
 * /auth/callback?next=... directly (PR #2 review). It never trusts
 * X-Forwarded-Host. No Supabase error text is reflected to the browser.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A PKCE auth code is a short opaque string; anything longer is not one. */
const MAX_CODE_LENGTH = 512

/** Responses that may carry session cookies are never cached. */
const NO_STORE = 'private, no-cache, no-store, must-revalidate, max-age=0'

function redirectTo(url: URL): NextResponse {
  const response = NextResponse.redirect(url, 302)
  response.headers.set('cache-control', NO_STORE)
  return response
}

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin
  const failure = new URL('/auth/error', origin)
  const code = request.nextUrl.searchParams.get('code')

  if (!code || code.length > MAX_CODE_LENGTH) return redirectTo(failure)

  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      // The error code only: Auth error messages can echo request data.
      console.warn('OAuth code exchange failed:', error.code ?? error.name)
      return redirectTo(failure)
    }
  } catch (error) {
    console.error('OAuth callback failed:', error instanceof Error ? error.name : 'unknown error')
    return redirectTo(failure)
  }

  return redirectTo(safeRedirect(request.nextUrl.searchParams.get('next'), origin))
}
