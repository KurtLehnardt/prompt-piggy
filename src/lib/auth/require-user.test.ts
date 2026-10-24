import type { User } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * requireUserPage / requireUserApi (REVIEW-2 R2-16; threat T27), tested with
 * an injected client. next/navigation's redirect() is replaced by one that
 * throws a recognizable error, like the real one does.
 */
class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`)
  }
}

const createClient = vi.fn()

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url)
  }),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))

const { getCurrentUser, getSignedInUser, requireUserApi, requireUserPage } = await import('./require-user')

function user(overrides: Partial<User> = {}): User {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    app_metadata: { provider: 'google' },
    user_metadata: {},
    created_at: '2026-10-24T00:00:00Z',
    is_anonymous: false,
    ...overrides,
  } as User
}

function client(result: { user: User | null; error?: unknown } | Error) {
  return {
    auth: {
      getUser: vi.fn(async () => {
        if (result instanceof Error) throw result
        return { data: { user: result.user }, error: result.error ?? null }
      }),
    },
  }
}

beforeEach(() => {
  createClient.mockReset()
})

describe('getSignedInUser', () => {
  it('returns a signed-in user', async () => {
    const signedIn = user()
    expect(await getSignedInUser(client({ user: signedIn }))).toBe(signedIn)
  })

  it.each([
    ['no user', { user: null }],
    ['an Auth error', { user: user(), error: { name: 'AuthSessionMissingError' } }],
    ['an anonymous user', { user: user({ is_anonymous: true }) }],
    ['a user without an id', { user: user({ id: '' }) }],
    ['a thrown network error', new Error('fetch failed')],
  ] as const)('returns null for %s', async (_label, result) => {
    expect(await getSignedInUser(client(result as never))).toBeNull()
  })

  it('asks the Auth server with getUser()', async () => {
    const fake = client({ user: user() })
    await getSignedInUser(fake)
    expect(fake.auth.getUser).toHaveBeenCalledTimes(1)
  })
})

describe('requireUserPage', () => {
  it('returns the user and the injected client', async () => {
    const signedIn = user()
    const fake = client({ user: signedIn })
    const result = await requireUserPage(fake)
    expect(result.user).toBe(signedIn)
    expect(result.supabase).toBe(fake)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('creates the server client when none is injected', async () => {
    const fake = client({ user: user() })
    createClient.mockResolvedValue(fake)
    expect((await requireUserPage()).supabase).toBe(fake)
  })

  it.each([
    ['signed out', { user: null }],
    ['anonymous', { user: user({ is_anonymous: true }) }],
    ['an Auth error', { user: null, error: new Error('invalid JWT') }],
  ] as const)('redirects to /login when %s', async (_label, result) => {
    await expect(requireUserPage(client(result as never))).rejects.toEqual(new RedirectSignal('/login'))
  })
})

describe('requireUserApi', () => {
  it('returns ok with the user and the client', async () => {
    const signedIn = user()
    const fake = client({ user: signedIn })
    const result = await requireUserApi(fake)
    expect(result).toEqual({ ok: true, user: signedIn, supabase: fake })
  })

  it.each([
    ['signed out', { user: null }],
    ['anonymous', { user: user({ is_anonymous: true }) }],
    ['an Auth error', { user: user(), error: { name: 'AuthApiError' } }],
  ] as const)('answers 401 unauthorized when %s', async (_label, result) => {
    const outcome = await requireUserApi(client(result as never))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.response.status).toBe(401)
    expect(await outcome.response.json()).toEqual({ error: 'Sign in required.', code: 'unauthorized' })
    expect(outcome.response.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 401 when getUser() throws', async () => {
    const outcome = await requireUserApi(client(new Error('network down')))
    expect(outcome.ok ? 200 : outcome.response.status).toBe(401)
  })

  it('answers 503 unavailable when Supabase is not configured', async () => {
    createClient.mockRejectedValue(new Error('Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL.'))
    const outcome = await requireUserApi()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.response.status).toBe(503)
    expect((await outcome.response.json()).code).toBe('unavailable')
  })
})

describe('getCurrentUser', () => {
  it('returns the user, or null when signed out or anonymous', async () => {
    const signedIn = user()
    expect(await getCurrentUser(client({ user: signedIn }))).toBe(signedIn)
    expect(await getCurrentUser(client({ user: null }))).toBeNull()
    expect(await getCurrentUser(client({ user: user({ is_anonymous: true }) }))).toBeNull()
  })

  it('returns null instead of throwing when Supabase is not configured', async () => {
    createClient.mockRejectedValue(new Error('Supabase is not configured'))
    expect(await getCurrentUser()).toBeNull()
  })
})
