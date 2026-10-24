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
     * - files under _next/static/, and _next/image (image optimization)
     * - /favicon.ico, and static images by extension outside /api
     * - the cookie-less public API routes /api/live/snapshot, /api/health,
     *   /api/cron/*, and /api/smoke, so CDN hits and cron calls never invoke
     *   the proxy (ARCHITECTURE section 7, REVIEW-1 R1-24a). Each one is
     *   followed by "/" or the end of the path, so /api/healthz, /api/cronjobs,
     *   and /api/smoker still run the proxy.
     * - generated metadata routes, which crawlers fetch without a session:
     *   /robots.txt, /manifest.webmanifest, sitemap.xml files, and the icon,
     *   apple-icon, opengraph-image, and twitter-image routes at any depth,
     *   with the optional hash suffix Next.js adds inside route groups and an
     *   optional image id. The sitemap, icon, and image-extension clauses
     *   start with (?!api/), so no /api route is ever skipped because one of
     *   its segments is named "icon" or ends in ".png" (P2R-04).
     *
     * Next.js reads this value statically at build time, so it must stay a
     * single string literal. src/lib/supabase/proxy-matcher.test.ts checks it
     * with Next.js's own matcher.
     */
    '/((?!_next/static/|_next/image$|favicon\\.ico$|api/(?:live/snapshot|health|cron|smoke)(?:/|$)|robots\\.txt$|manifest\\.webmanifest$|(?!api/)(?:.*/)?sitemap(?:/[^/]+)?\\.xml$|(?!api/)(?:.*/)?(?:icon|apple-icon|opengraph-image|twitter-image)(?:-[a-z0-9]{1,6})?(?:/[^/]+)?$|(?!api/).*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)',
  ],
}
