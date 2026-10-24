import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'

type CookieToSet = { name: string; value: string; options: Record<string, unknown> }
type CookieMethods = {
  getAll: () => { name: string; value: string }[]
  setAll: (cookies: CookieToSet[]) => void
}

const ssr = vi.hoisted(() => ({
  claimsSub: null as string | null,
  getClaimsThrows: false,
  cookiesToSetOnRefresh: [] as CookieToSet[],
  createServerClient: vi.fn(),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: ssr.createServerClient,
}))

import { HOME_PATH, LOGIN_PATH, PUBLIC_PATHS, isPublicPath, updateSession } from './proxy'
import { config as proxyConfig } from '@/proxy'

function fakeServerClient(_url: string, _key: string, options: { cookies: CookieMethods }) {
  return {
    auth: {
      async getClaims() {
        if (ssr.getClaimsThrows) throw new Error('network down')
        if (ssr.cookiesToSetOnRefresh.length > 0) {
          options.cookies.setAll(ssr.cookiesToSetOnRefresh)
        }
        return ssr.claimsSub
          ? { data: { claims: { sub: ssr.claimsSub } }, error: null }
          : { data: null, error: null }
      },
    },
  }
}

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, 'https://piggy.test'))
}

function isPassThrough(response: NextResponse): boolean {
  return response.headers.get('x-middleware-next') === '1'
}

function redirectPath(response: NextResponse): string | null {
  const location = response.headers.get('location')
  return location ? new URL(location).pathname : null
}

beforeEach(() => {
  ssr.claimsSub = null
  ssr.getClaimsThrows = false
  ssr.cookiesToSetOnRefresh = []
  ssr.createServerClient.mockReset()
  ssr.createServerClient.mockImplementation(fakeServerClient)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake-project.supabase.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-anon-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('public paths without a user', () => {
  const publicPaths = [
    '/',
    '/login',
    '/auth/callback',
    '/auth/error',
    '/live',
    '/health',
    '/api/live/snapshot',
    '/api/health',
    '/api/cron/daily',
    '/api/cron/hardening',
    '/api/smoke',
    '/api/test/login',
  ]

  it.each(publicPaths)('%s passes through', async (path) => {
    const response = await updateSession(request(path))
    expect(isPassThrough(response)).toBe(true)
    expect(response.status).toBe(200)
  })

  it('lists exactly the documented public paths', () => {
    expect([...PUBLIC_PATHS].sort()).toEqual(
      [
        '/login',
        '/auth/callback',
        '/auth/error',
        '/live',
        '/health',
        '/api/live/snapshot',
        '/api/health',
        '/api/cron',
        '/api/smoke',
        '/api/test/login',
      ].sort()
    )
  })
})

describe('boundary matching', () => {
  it.each(['/api/cronjobs', '/healthz', '/livestream', '/loginx', '/api/healthcheck'])(
    '%s is not public',
    (path) => {
      expect(isPublicPath(path)).toBe(false)
    }
  )

  it.each(['/api/cron', '/api/cron/daily', '/live/', '/health/'])('%s is public', (path) => {
    expect(isPublicPath(path)).toBe(true)
  })

  it('matches / exactly and not as a prefix of every path', () => {
    expect(isPublicPath('/')).toBe(true)
    expect(isPublicPath('/play')).toBe(false)
  })

  it('returns 401 JSON for /api/cronjobs without a user', async () => {
    const response = await updateSession(request('/api/cronjobs'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Sign in required.', code: 'unauthorized' })
  })

  it.each(['/healthz', '/livestream'])('redirects %s to /login without a user', async (path) => {
    const response = await updateSession(request(path))
    expect(isPassThrough(response)).toBe(false)
    expect(redirectPath(response)).toBe(LOGIN_PATH)
  })
})

describe('protected pages', () => {
  it('redirects an unauthenticated /play to /login', async () => {
    const response = await updateSession(request('/play?tab=wallet'))
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/login')
    expect(location.search).toBe('')
    expect(location.origin).toBe('https://piggy.test')
  })

  it('lets an authenticated user through to /play', async () => {
    ssr.claimsSub = 'user-1'
    const response = await updateSession(request('/play'))
    expect(isPassThrough(response)).toBe(true)
  })

  it('redirects an authenticated /login to /play', async () => {
    ssr.claimsSub = 'user-1'
    const response = await updateSession(request('/login'))
    expect(response.status).toBe(307)
    expect(redirectPath(response)).toBe(HOME_PATH)
  })

  it('lets an authenticated user reach a protected API route', async () => {
    ssr.claimsSub = 'user-1'
    const response = await updateSession(request('/api/attempts'))
    expect(isPassThrough(response)).toBe(true)
  })

  it('treats a getClaims failure as signed out', async () => {
    ssr.getClaimsThrows = true
    const page = await updateSession(request('/play'))
    expect(redirectPath(page)).toBe(LOGIN_PATH)
    const publicPage = await updateSession(request('/live'))
    expect(isPassThrough(publicPage)).toBe(true)
  })
})

describe('session refresh', () => {
  const refreshed: CookieToSet = {
    name: 'sb-fake-auth-token',
    value: 'fake-refreshed-token',
    options: { path: '/', httpOnly: true, sameSite: 'lax' },
  }

  it('writes refreshed cookies and no-store headers on a pass-through response', async () => {
    ssr.claimsSub = 'user-1'
    ssr.cookiesToSetOnRefresh = [refreshed]
    const response = await updateSession(request('/play'))
    expect(isPassThrough(response)).toBe(true)
    expect(response.cookies.get(refreshed.name)?.value).toBe(refreshed.value)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('carries cookies set during getClaims onto a redirect', async () => {
    ssr.claimsSub = 'user-1'
    ssr.cookiesToSetOnRefresh = [refreshed]
    const response = await updateSession(request('/login'))
    expect(redirectPath(response)).toBe(HOME_PATH)
    expect(response.cookies.get(refreshed.name)?.value).toBe(refreshed.value)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('carries a cleared session cookie onto the login redirect', async () => {
    ssr.cookiesToSetOnRefresh = [{ name: refreshed.name, value: '', options: { maxAge: 0 } }]
    const response = await updateSession(request('/play'))
    expect(redirectPath(response)).toBe(LOGIN_PATH)
    expect(response.cookies.get(refreshed.name)?.value).toBe('')
  })

  it('does not add no-store headers when no cookie changes', async () => {
    ssr.claimsSub = 'user-1'
    const response = await updateSession(request('/play'))
    expect(response.headers.get('cache-control')).toBeNull()
  })
})

describe('missing Supabase environment', () => {
  it.each(['/play', '/api/attempts', '/health', '/'])(
    '%s passes through without creating a client',
    async (path) => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
      const response = await updateSession(request(path))
      expect(isPassThrough(response)).toBe(true)
      expect(ssr.createServerClient).not.toHaveBeenCalled()
    }
  )
})

describe('src/proxy.ts matcher', () => {
  const [pattern] = proxyConfig.matcher
  const matcher = new RegExp(`^${pattern}$`)

  it.each(['/', '/play', '/login', '/health', '/api/attempts', '/auth/callback'])(
    'runs on %s',
    (path) => {
      expect(matcher.test(path)).toBe(true)
    }
  )

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
  ])('skips %s', (path) => {
    expect(matcher.test(path)).toBe(false)
  })
})
