import type { User } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Admin identity (docs/ARCHITECTURE.md section 11, T21; CH-7; REVIEW-2
 * R2-16), table-driven, with an injected client and admin list.
 */
class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`)
  }
}

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url)
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('Supabase is not configured')
  }),
}))

const ADMIN = 'operator@example.com'

function user(overrides: Partial<User> = {}): User {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    aud: 'authenticated',
    email: ADMIN,
    email_confirmed_at: '2026-10-20T12:00:00Z',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: {},
    created_at: '2026-10-20T12:00:00Z',
    is_anonymous: false,
    ...overrides,
  } as User
}

function client(signedIn: User | null) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user: signedIn }, error: null })) } }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('ADMIN_EMAILS', undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function load() {
  return import('./require-admin')
}

describe('isAdminUser', () => {
  const cases: [label: string, candidate: User | null, list: string[], expected: boolean][] = [
    ['a listed, confirmed Google user', user(), [ADMIN], true],
    ['an email that differs only by case', user({ email: 'Operator@Example.COM' }), [ADMIN], true],
    ['an email with surrounding whitespace', user({ email: `  ${ADMIN}\t` }), [ADMIN], true],
    ['a list entry with odd case and whitespace', user(), ['  OPERATOR@example.com  '], true],
    ['one of several listed emails', user(), ['someone@example.com', ADMIN], true],
    ['an email that is not listed', user({ email: 'player@example.com' }), [ADMIN], false],
    ['a listed email on a sub-address', user({ email: 'operator+x@example.com' }), [ADMIN], false],
    ['a listed email from the email provider', user({ app_metadata: { provider: 'email' } }), [ADMIN], false],
    ['a listed email from another provider', user({ app_metadata: { provider: 'azure' } }), [ADMIN], false],
    ['a listed email with no provider', user({ app_metadata: {} }), [ADMIN], false],
    [
      'Google named only in user_metadata, which the user can edit',
      user({ app_metadata: { provider: 'email' }, user_metadata: { provider: 'google' } }),
      [ADMIN],
      false,
    ],
    ['an unconfirmed email', user({ email_confirmed_at: undefined }), [ADMIN], false],
    ['an empty confirmation time', user({ email_confirmed_at: '' }), [ADMIN], false],
    ['an unparseable confirmation time', user({ email_confirmed_at: 'not a date' }), [ADMIN], false],
    ['an anonymous user', user({ is_anonymous: true }), [ADMIN], false],
    ['a user without an email', user({ email: undefined }), [ADMIN], false],
    ['an empty email', user({ email: '' }), [''], false],
    ['an empty admin list', user(), [], false],
    ['an admin list of blanks', user(), ['', '  '], false],
    ['no user', null, [ADMIN], false],
  ]

  it.each(cases)('%s -> %s', async (_label, candidate, list, expected) => {
    const { isAdminUser } = await load()
    expect(isAdminUser(candidate, list)).toBe(expected)
  })
})

describe('configuredAdminEmails', () => {
  it('reads ADMIN_EMAILS trimmed and lowercased', async () => {
    vi.stubEnv('ADMIN_EMAILS', ` ${ADMIN.toUpperCase()} , second@example.com `)
    const { configuredAdminEmails } = await load()
    expect(configuredAdminEmails()).toEqual([ADMIN, 'second@example.com'])
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only commas and spaces', ' , , '],
  ])('admits no one when ADMIN_EMAILS is %s', async (_label, value) => {
    vi.stubEnv('ADMIN_EMAILS', value)
    const { configuredAdminEmails, isAdminUser } = await load()
    expect(configuredAdminEmails()).toEqual([])
    expect(isAdminUser(user(), configuredAdminEmails())).toBe(false)
  })

  it('admits no one when the server environment does not parse', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'not-an-email')
    const { configuredAdminEmails } = await load()
    expect(configuredAdminEmails()).toEqual([])
  })
})

describe('requireAdminApi', () => {
  it('returns the admin', async () => {
    const { requireAdminApi } = await load()
    const admin = user()
    const result = await requireAdminApi({ client: client(admin), adminEmails: [ADMIN] })
    expect(result.ok && result.user).toBe(admin)
  })

  it('answers 401 for a signed-out visitor', async () => {
    const { requireAdminApi } = await load()
    const result = await requireAdminApi({ client: client(null), adminEmails: [ADMIN] })
    expect(result.ok ? 200 : result.response.status).toBe(401)
  })

  it.each([
    ['a non-admin', user({ email: 'player@example.com' })],
    ['a listed email from another provider', user({ app_metadata: { provider: 'email' } })],
    ['an unconfirmed email', user({ email_confirmed_at: undefined })],
  ])('answers 403 forbidden for %s', async (_label, candidate) => {
    const { requireAdminApi } = await load()
    const result = await requireAdminApi({ client: client(candidate), adminEmails: [ADMIN] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
    expect(await result.response.json()).toEqual({ error: 'You are not allowed to do that.', code: 'forbidden' })
  })

  it('answers 403 when ADMIN_EMAILS is unset', async () => {
    const { requireAdminApi } = await load()
    const result = await requireAdminApi({ client: client(user()) })
    expect(result.ok ? 200 : result.response.status).toBe(403)
  })

  it('reads ADMIN_EMAILS when no list is injected', async () => {
    vi.stubEnv('ADMIN_EMAILS', ADMIN)
    const { requireAdminApi } = await load()
    const result = await requireAdminApi({ client: client(user()) })
    expect(result.ok).toBe(true)
  })
})

describe('requireAdminPage', () => {
  it('returns the admin', async () => {
    const { requireAdminPage } = await load()
    const admin = user()
    expect((await requireAdminPage({ client: client(admin), adminEmails: [ADMIN] })).user).toBe(admin)
  })

  it('redirects a signed-out visitor to /login', async () => {
    const { requireAdminPage } = await load()
    await expect(requireAdminPage({ client: client(null), adminEmails: [ADMIN] })).rejects.toEqual(
      new RedirectSignal('/login')
    )
  })

  it('redirects a signed-in non-admin to /play', async () => {
    const { requireAdminPage } = await load()
    await expect(
      requireAdminPage({ client: client(user({ email: 'player@example.com' })), adminEmails: [ADMIN] })
    ).rejects.toEqual(new RedirectSignal('/play'))
  })
})

describe('source', () => {
  const source = readFileSync(path.join(__dirname, 'require-admin.ts'), 'utf8')

  it('hardcodes no email address', () => {
    expect(source).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  })

  it('never reads user_metadata', () => {
    expect(source).not.toMatch(/user_metadata\s*[?.[]/)
  })
})
