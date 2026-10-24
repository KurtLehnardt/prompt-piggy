import { AsyncLocalStorage } from 'node:async_hooks'
import { beforeAll, describe, expect, it } from 'vitest'
import { config as proxyConfig } from '@/proxy'

/**
 * Checks the src/proxy.ts matcher with Next.js's own matcher compiler, the one
 * the build uses, rather than a hand-built RegExp.
 */
type DoesMatch = (input: { config: { matcher: string[] }; url: string }) => boolean
let doesMatch: DoesMatch

beforeAll(async () => {
  // Next.js's server modules expect the global that its Node runtime installs.
  const globals = globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }
  globals.AsyncLocalStorage ??= AsyncLocalStorage
  const testing = await import('next/experimental/testing/server')
  doesMatch = testing.unstable_doesMiddlewareMatch as DoesMatch
})

function runsOn(url: string): boolean {
  return doesMatch({ config: { matcher: [...proxyConfig.matcher] }, url })
}

describe('src/proxy.ts matcher', () => {
  it('is a single pattern', () => {
    expect(proxyConfig.matcher).toHaveLength(1)
  })

  it.each([
    '/',
    '/play',
    '/play?tab=wallet',
    '/login',
    '/live',
    '/health',
    '/auth/callback',
    '/auth/signout',
    '/admin',
    '/api/attempts',
    '/api/wallet/repair',
    '/api/test/login',
  ])('runs on %s', (path) => {
    expect(runsOn(path)).toBe(true)
  })

  it.each([
    '/_next/static/chunks/main.js',
    '/_next/image',
    '/favicon.ico',
    '/pig.svg',
    '/images/hero.png',
    '/photo.jpg',
    '/photo.jpeg',
    '/anim.gif',
    '/img.webp',
    '/img.avif',
  ])('skips the static asset %s', (path) => {
    expect(runsOn(path)).toBe(false)
  })

  it.each([
    '/api/live/snapshot',
    '/api/live/snapshot?since=12',
    '/api/health',
    '/api/cron',
    '/api/cron/daily',
    '/api/cron/hardening',
    '/api/smoke',
  ])('skips the cookie-less public API route %s', (path) => {
    expect(runsOn(path)).toBe(false)
  })

  it.each([
    '/api/healthz',
    '/api/healthcheck',
    '/api/cronjobs',
    '/api/smoker',
    '/api/live',
    '/api/live/snapshots',
  ])('still runs on the look-alike %s (boundary match)', (path) => {
    expect(runsOn(path)).toBe(true)
  })

  it.each([
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap/0.xml',
    '/manifest.webmanifest',
    '/icon',
    '/icon/small',
    '/icon-a1b2c3',
    '/apple-icon',
    '/opengraph-image',
    '/opengraph-image-a1b2c3',
    '/live/opengraph-image',
    '/twitter-image',
    '/live/twitter-image/1',
  ])('skips the metadata route %s', (path) => {
    expect(runsOn(path)).toBe(false)
  })

  it.each([
    '/api/icon',
    '/api/attempts/icon',
    '/api/admin/players/icon/hide',
    '/api/live/icon',
    '/api/opengraph-image',
    '/api/players/twitter-image/1',
    '/api/sitemap.xml',
    '/api/admin/sitemap/0.xml',
    '/api/avatars/fake-id.png',
  ])('still runs on the protected API route %s (P2R-04)', (path) => {
    expect(runsOn(path)).toBe(true)
  })

  it.each(['/favicon.icox', '/favicon.ico/x', '/_next/staticx', '/_next/imagex', '/_next/image/x'])(
    'still runs on the unanchored look-alike %s',
    (path) => {
      expect(runsOn(path)).toBe(true)
    }
  )

  it.each(['/iconography', '/icons', '/robots.txt.bak', '/manifest', '/opengraph-imagery'])(
    'still runs on the look-alike %s',
    (path) => {
      expect(runsOn(path)).toBe(true)
    }
  )
})
