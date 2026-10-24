import { NextResponse, type NextRequest } from 'next/server'
import { errorResponse, jsonError, mapRpcError } from '@/lib/errors'
import { assertSameOrigin } from '@/lib/http/origin'
import { createClient } from '@/lib/supabase/server'

/**
 * Sign-out (docs/ARCHITECTURE.md section 7). POST only, so a link, an image,
 * or a prefetch can never sign a player out; GET answers 405.
 *
 * A cross-site form could still POST here, so the Origin header must be one of
 * the app origins (assertSameOrigin, R1-04); anything else gets 403
 * `forbidden` and the session is left alone. Then signOut() revokes the
 * session and @supabase/ssr clears the session cookies, and the player is
 * redirected to the start page. auth-js clears the local session even when
 * the revoke request fails, so the redirect always leaves the browser signed
 * out.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = 'private, no-cache, no-store, must-revalidate, max-age=0'

export async function POST(request: NextRequest) {
  if (!assertSameOrigin(request)) return jsonError('forbidden', 403)

  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut()
    if (error) console.warn('Sign-out could not revoke the session:', error.code ?? error.name)
  } catch (error) {
    return errorResponse(mapRpcError(error))
  }

  // 302 after a POST makes the browser load / with GET.
  const response = NextResponse.redirect(new URL('/', request.nextUrl.origin), 302)
  response.headers.set('cache-control', NO_STORE)
  return response
}

export function GET() {
  const response = jsonError('invalid_request', 405, 'Use POST to sign out.')
  response.headers.set('allow', 'POST')
  return response
}
