import 'server-only'
import { getEnv } from '@/lib/env'
import { readAppOrigin } from '@/lib/public-env'

/**
 * The CSRF guard for state-changing routes (docs/ARCHITECTURE.md section 7,
 * R1-04, R2-10). A route answers 403 `forbidden` when this returns false.
 *
 * The allowed origins are the NEXT_PUBLIC_APP_URL origin and, only on a
 * Vercel preview deployment (VERCEL_ENV === 'preview'), the per-deployment
 * URL https://VERCEL_URL and the branch alias https://VERCEL_BRANCH_URL.
 */
export function allowedOrigins(): ReadonlySet<string> {
  const origins = new Set<string>()
  const appOrigin = readAppOrigin()
  if (appOrigin) origins.add(appOrigin)

  const env = getEnv()
  if (env.VERCEL_ENV === 'preview') {
    for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
      const origin = host ? originOf(`https://${host}`) : null
      if (origin) origins.add(origin)
    }
  }
  return origins
}

function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * True only when the request's Origin header is exactly one of the allowed
 * origins. A missing Origin, `Origin: null`, a header that is not a bare
 * origin, and every other origin are refused, so the check fails closed. It
 * also fails closed when NEXT_PUBLIC_APP_URL is unset outside previews.
 */
export function assertSameOrigin(request: Request): boolean {
  const header = request.headers.get('origin')
  if (!header) return false
  const origin = originOf(header)
  // An Origin header is scheme://host[:port] and nothing else.
  if (!origin || origin !== header.toLowerCase()) return false
  return allowedOrigins().has(origin)
}
