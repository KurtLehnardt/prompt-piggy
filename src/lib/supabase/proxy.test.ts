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
  // What the Auth server says about the session behind the claims. null means
  // the session was revoked (signed out elsewhere) or the user was deleted.
  userId: null as string | null,
  getUserThrows: false,
  getUserCalls: 0,
  cookiesToSetOnRefresh: [] as CookieToSet[],
  createServerClient: vi.fn(),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: ssr.createServerClient,
}))

import {
  HOME_PATH,
  LOGIN_PATH,
  NEXT_PARAM,
  PUBLIC_PATHS,
  isPublicPath,
  safeNextPath,
  updateSession,
} from './proxy'

const ORIGIN = 'https://piggy.test'
const SESSION_COOKIE = 'sb-fake-project-auth-token'

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
      async getUser() {
        ssr.getUserCalls += 1
        if (ssr.getUserThrows) throw new Error('network down')
        if (ssr.userId) return { data: { user: { id: ssr.userId } }, error: null }
        // auth-js clears the stored session when the Auth server reports
        // session_not_found, which @supabase/ssr turns into setAll().
        options.cookies.setAll([{ name: SESSION_COOKIE, value: '', options: { maxAge: 0 } }])
        return { data: { user: null }, error: new Error('Auth session missing!') }
      },
    },
  }
}

function signIn(userId = 'user-1') {
  ssr.claimsSub = userId
  ssr.userId = userId
}

/** Claims that still verify locally, for a session the Auth server no longer has. */
function revokeSession(userId = 'user-1') {
  ssr.claimsSub = userId
  ssr.userId = null
}

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN))
}

function isPassThrough(response: NextResponse): boolean {
  return response.headers.get('x-middleware-next') === '1'
}

function redirectPath(response: NextResponse): string | null {
  const location = response.headers.get('location')
  return location ? new URL(location).pathname : null
}

function redirectNext(response: NextResponse): string | null {
  const location = response.headers.get('location')
  return location ? new URL(location).searchParams.get(NEXT_PARAM) : null
}

/**
 * Follows the proxy's redirects the way a browser would and fails on a loop.
 * Returns every path and query visited, in order, and the final response.
 */
async function follow(path: string, maxHops = 5) {
  const visited: string[] = []
  let url = new URL(path, ORIGIN)
  for (let hop = 0; hop <= maxHops; hop++) {
    const key = url.pathname + url.search
    if (visited.includes(key)) {
      throw new Error(`Redirect loop: ${[...visited, key].join(' -> ')}`)
    }
    visited.push(key)
    const response = await updateSession(new NextRequest(url))
    const location = response.headers.get('location')
    if (!location) return { visited, final: response }
    url = new URL(location)
    expect(url.origin).toBe(ORIGIN)
  }
  throw new Error(`More than ${maxHops} redirects: ${visited.join(' -> ')}`)
}

beforeEach(() => {
  ssr.claimsSub = null
  ssr.getClaimsThrows = false
  ssr.userId = null
  ssr.getUserThrows = false
  ssr.getUserCalls = 0
  ssr.cookiesToSetOnRefresh = []
  ssr.createServerClient.mockReset()
  ssr.createServerClient.mockImplementation(fakeServerClient)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake-project.supabase.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'fake-publishable-key')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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
  it('redirects an unauthenticated /play to /login and keeps the page in next', async () => {
    const response = await updateSession(request('/play?tab=wallet'))
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname).toBe('/login')
    expect([...location.searchParams.keys()]).toEqual([NEXT_PARAM])
    expect(location.searchParams.get(NEXT_PARAM)).toBe('/play?tab=wallet')
  })

  it('lets a confirmed user through to /play', async () => {
    signIn()
    const response = await updateSession(request('/play'))
    expect(isPassThrough(response)).toBe(true)
    expect(ssr.getUserCalls).toBe(1)
  })

  it('redirects a confirmed user on /login to /play', async () => {
    signIn()
    const response = await updateSession(request('/login'))
    expect(response.status).toBe(307)
    expect(redirectPath(response)).toBe(HOME_PATH)
    expect(ssr.getUserCalls).toBe(1)
  })

  it('sends a confirmed user on /login to a safe next path', async () => {
    signIn()
    const response = await updateSession(request('/login?next=%2Fplay%3Ftab%3Dwallet'))
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname + location.search).toBe('/play?tab=wallet')
  })

  it.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example/play',
    '/%2F%2Fevil.example',
    '/login',
    '/login?next=/login',
    '/api/attempts',
  ])('ignores the unsafe next %s on /login and goes to /play', async (next) => {
    signIn()
    const response = await updateSession(request(`/login?next=${encodeURIComponent(next)}`))
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname + location.search).toBe(HOME_PATH)
  })

  it('lets an authenticated user reach a protected API route without an Auth server call', async () => {
    signIn()
    const response = await updateSession(request('/api/attempts'))
    expect(isPassThrough(response)).toBe(true)
    expect(ssr.getUserCalls).toBe(0)
  })

  it('does not call the Auth server for public pages', async () => {
    signIn()
    for (const path of ['/', '/live', '/health', '/auth/callback']) {
      expect(isPassThrough(await updateSession(request(path)))).toBe(true)
    }
    expect(ssr.getUserCalls).toBe(0)
  })

  it('treats a getClaims failure as signed out', async () => {
    ssr.getClaimsThrows = true
    const page = await updateSession(request('/play'))
    expect(redirectPath(page)).toBe(LOGIN_PATH)
    const publicPage = await updateSession(request('/live'))
    expect(isPassThrough(publicPage)).toBe(true)
  })
})

describe('revoked session (claims verify locally, the Auth server has no session)', () => {
  it('redirects /play to /login and clears the session cookie', async () => {
    revokeSession()
    const response = await updateSession(request('/play'))
    expect(redirectPath(response)).toBe(LOGIN_PATH)
    expect(redirectNext(response)).toBe('/play')
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe('')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('lets /login render instead of sending the visitor back to /play', async () => {
    revokeSession()
    const response = await updateSession(request('/login?next=%2Fplay'))
    expect(isPassThrough(response)).toBe(true)
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe('')
  })

  it.each(['/play', '/play?tab=wallet', '/login', '/admin'])(
    'settles on /login without a redirect loop when starting at %s',
    async (start) => {
      revokeSession()
      const { visited, final } = await follow(start)
      expect(isPassThrough(final)).toBe(true)
      expect(new URL(visited.at(-1)!, ORIGIN).pathname).toBe(LOGIN_PATH)
      expect(visited.length).toBeLessThanOrEqual(2)
    }
  )

  it('settles on /login without a loop when the Auth server is unreachable', async () => {
    ssr.claimsSub = 'user-1'
    ssr.getUserThrows = true
    const { visited, final } = await follow('/play')
    expect(isPassThrough(final)).toBe(true)
    expect(visited).toEqual(['/play', '/login?next=%2Fplay'])
  })

  it('still reaches the API route handler, which verifies the user itself', async () => {
    revokeSession()
    const response = await updateSession(request('/api/attempts'))
    expect(isPassThrough(response)).toBe(true)
    expect(ssr.getUserCalls).toBe(0)
  })

  it('a confirmed user also settles without a loop', async () => {
    signIn()
    const { visited, final } = await follow('/login?next=%2Fplay%3Ftab%3Dwallet')
    expect(isPassThrough(final)).toBe(true)
    expect(visited).toEqual(['/login?next=%2Fplay%3Ftab%3Dwallet', '/play?tab=wallet'])
  })
})

describe('safeNextPath', () => {
  it.each([
    ['/play', '/play'],
    ['/play?tab=wallet', '/play?tab=wallet'],
    ['/live', '/live'],
    ['/play/../admin', '/admin'],
    ['/play#section', '/play'],
  ])('accepts %s as %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected)
  })

  it.each([
    null,
    undefined,
    '',
    'play',
    '//evil.example',
    '/\\evil.example',
    '/play\\..\\evil',
    '/%2fevil.example',
    '/%5Cevil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/play\nLocation: https://evil.example',
    '/play\t',
    '/login',
    '/login/',
    '/login?next=/play',
    '/api/attempts',
    `/${'a'.repeat(2048)}`,
  ])('rejects %j', (input) => {
    expect(safeNextPath(input)).toBeNull()
  })
})

describe('session refresh', () => {
  const refreshed: CookieToSet = {
    name: 'sb-fake-auth-token',
    value: 'fake-refreshed-token',
    options: { path: '/', httpOnly: true, sameSite: 'lax' },
  }

  it('writes refreshed cookies and no-store headers on a pass-through response', async () => {
    signIn()
    ssr.cookiesToSetOnRefresh = [refreshed]
    const response = await updateSession(request('/play'))
    expect(isPassThrough(response)).toBe(true)
    expect(response.cookies.get(refreshed.name)?.value).toBe(refreshed.value)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('carries cookies set during getClaims onto a redirect', async () => {
    signIn()
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
    signIn()
    const response = await updateSession(request('/play'))
    expect(response.headers.get('cache-control')).toBeNull()
  })
})

describe('environment variable names', () => {
  it('falls back to the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-legacy-anon-key')
    signIn()
    const response = await updateSession(request('/play'))
    expect(isPassThrough(response)).toBe(true)
    expect(ssr.createServerClient).toHaveBeenCalledWith(
      'https://fake-project.supabase.test',
      'fake-legacy-anon-key',
      expect.anything()
    )
  })

  it('prefers NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY when both are set', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-legacy-anon-key')
    await updateSession(request('/'))
    expect(ssr.createServerClient).toHaveBeenCalledWith(
      'https://fake-project.supabase.test',
      'fake-publishable-key',
      expect.anything()
    )
  })
})

describe('missing or partial Supabase environment (fail closed)', () => {
  const configurations = [
    ['no Supabase settings', { NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' }],
    ['only the URL', { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' }],
    ['only a key', { NEXT_PUBLIC_SUPABASE_URL: '' }],
  ] as const

  function apply(env: Readonly<Record<string, string>>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  }

  describe.each(configurations)('with %s', (_label, env) => {
    beforeEach(() => {
      apply(env)
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    it.each(['/', '/health', '/live', '/login', '/auth/callback'])(
      'public path %s passes through without creating a client',
      async (path) => {
        const response = await updateSession(request(path))
        expect(isPassThrough(response)).toBe(true)
        expect(ssr.createServerClient).not.toHaveBeenCalled()
      }
    )

    it.each(['/play', '/admin', '/healthz'])('page %s returns 503, not a pass-through', async (path) => {
      const response = await updateSession(request(path))
      expect(isPassThrough(response)).toBe(false)
      expect(response.status).toBe(503)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(ssr.createServerClient).not.toHaveBeenCalled()
    })

    it.each(['/api/attempts', '/api/cronjobs'])('API route %s returns 503 JSON', async (path) => {
      const response = await updateSession(request(path))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: 'The service is not configured yet.',
        code: 'internal',
      })
    })
  })

  it('logs the missing names once, never a value', async () => {
    vi.resetModules()
    const { updateSession: freshUpdateSession } = await import('./proxy')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake-secret-looking-url.supabase.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await freshUpdateSession(request('/play'))
    await freshUpdateSession(request('/api/attempts'))
    expect(error).toHaveBeenCalledTimes(1)
    const message = String(error.mock.calls[0][0])
    expect(message).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
    expect(message).not.toContain('NEXT_PUBLIC_SUPABASE_URL')
    expect(message).not.toContain('fake-secret-looking-url')
  })
})
