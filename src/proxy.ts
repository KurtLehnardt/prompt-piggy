import type { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'

/**
 * Next.js 16 Proxy (formerly Middleware). It runs on the Node.js runtime by
 * default and must not export `runtime`.
 *
 * Its only job is to refresh the Supabase session and gate pages that need a
 * user. Game logic, including the Dynamic Validator, never runs here (HC-A4);
 * src/lib/supabase/proxy-scope.test.ts enforces that this file imports nothing
 * else.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match every request path except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - static images by extension
     */
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)',
  ],
}
