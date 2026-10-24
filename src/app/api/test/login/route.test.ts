import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Test-only login (docs/ARCHITECTURE.md section 7 and section 11 T23). The
 * real isE2ETestMode() is used, so the 404 cases run against the actual flag
 * logic; only the Supabase clients are fakes. Each test re-imports the route
 * so the cached server settings start empty.
 */
const APP = 'http://localhost:3000'
const LOCAL_SUPABASE = 'http://127.0.0.1:54321'
const EMAIL = 'player-one@e2e.prompt-piggy.test'
const USER_ID = '00000000-0000-4000-8000-0000000000e2'

const admin = {
  createUser: vi.fn(),
  listUsers: vi.fn(),
  updateUserById: vi.fn(),
}
const signInWithPassword = vi.fn()
const createAdminClient = vi.fn(() => ({ auth: { admin } }))
const createClient = vi.fn(async () => ({ auth: { signInWithPassword } }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('E2E_TEST_MODE', 'true')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL_SUPABASE)
  for (const name of ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL']) vi.stubEnv(name, undefined)
  for (const mock of [admin.createUser, admin.listUsers, admin.updateUserById, signInWithPassword]) mock.mockReset()
  createAdminClient.mockClear()
  createClient.mockClear()
  admin.createUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null })
  signInWithPassword.mockResolvedValue({ data: { user: { id: USER_ID }, session: {} }, error: null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function load() {
  return import('./route')
}

function post(body: unknown, origin: string | null = APP): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== null) headers.set('origin', origin)
  return new NextRequest(`${APP}/api/test/login`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'Not found.', code: 'not_found' })
  expect(createAdminClient).not.toHaveBeenCalled()
  expect(createClient).not.toHaveBeenCalled()
}

describe('outside E2E mode the route does not exist (T23)', () => {
  it('answers 404 with NODE_ENV production, even with E2E_TEST_MODE=true', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await expectNotFound(await (await load()).POST(post({ email: EMAIL })))
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['"1"', '1'],
    ['"TRUE"', 'TRUE'],
  ])('answers 404 when E2E_TEST_MODE is %s', async (_label, value) => {
    vi.stubEnv('E2E_TEST_MODE', value)
    await expectNotFound(await (await load()).POST(post({ email: EMAIL })))
  })

  it('answers 404 before checking the Origin or the body', async () => {
    vi.stubEnv('E2E_TEST_MODE', undefined)
    await expectNotFound(await (await load()).POST(post('not json', 'https://evil.example')))
  })

  it.each([
    ['a hosted project', 'https://abcdefghijklmnopqrst.supabase.co'],
    ['a look-alike host', 'http://127.0.0.1.evil.example:54321'],
    ['an unset URL', undefined],
  ])('answers 404 in E2E mode when Supabase is %s, not a local stack', async (_label, url) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url)
    await expectNotFound(await (await load()).POST(post({ email: EMAIL })))
  })

  it('answers 404 to GET in every mode', async () => {
    const response = (await load()).GET()
    expect(response.status).toBe(404)
  })
})

describe('in E2E mode against local Supabase', () => {
  it('answers 403 to a cross-origin POST without touching Supabase', async () => {
    for (const origin of ['https://evil.example', 'null', null]) {
      const response = await (await load()).POST(post({ email: EMAIL }, origin))
      expect(response.status).toBe(403)
      expect((await response.json()).code).toBe('forbidden')
    }
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', 'not json'],
    ['a missing email', {}],
    ['an invalid email', { email: 'not-an-email' }],
    ['an unknown key', { email: EMAIL, password: 'chosen' }],
  ])('answers 400 for %s', async (_label, body) => {
    const response = await (await load()).POST(post(body))
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('invalid_request')
  })

  it.each(['someone@gmail.com', 'player@e2e.prompt-piggy.test.evil.example', 'player@prompt-piggy.test'])(
    'answers 403 for %s, outside the reserved test domain',
    async (email) => {
      const response = await (await load()).POST(post({ email }))
      expect(response.status).toBe(403)
      expect(createAdminClient).not.toHaveBeenCalled()
    }
  )

  it('creates a new password user and signs in through the server client', async () => {
    const response = await (await load()).POST(post({ email: EMAIL }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, userId: USER_ID })
    expect(response.headers.get('cache-control')).toContain('no-store')

    const created = admin.createUser.mock.calls[0][0]
    expect(created).toMatchObject({ email: EMAIL, email_confirm: true })
    expect(created.password).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: created.password })
    expect(JSON.stringify(body)).not.toContain(created.password)
  })

  it('lowercases the email', async () => {
    await (await load()).POST(post({ email: EMAIL.toUpperCase() }))
    expect(admin.createUser.mock.calls[0][0].email).toBe(EMAIL)
  })

  it('uses a fresh random password on every call', async () => {
    const route = await load()
    await route.POST(post({ email: EMAIL }))
    await route.POST(post({ email: EMAIL }))
    const [first, second] = admin.createUser.mock.calls.map(([args]) => args.password)
    expect(first).not.toBe(second)
  })

  it('resets the password of an existing user, then signs in', async () => {
    admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', code: 'email_exists', status: 422 },
    })
    admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'other', email: 'other@e2e.prompt-piggy.test' }, { id: USER_ID, email: EMAIL }] },
      error: null,
    })
    admin.updateUserById.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null })

    const response = await (await load()).POST(post({ email: EMAIL }))
    expect(response.status).toBe(200)
    const password = admin.createUser.mock.calls[0][0].password
    expect(admin.updateUserById).toHaveBeenCalledWith(USER_ID, { password })
    expect(signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password })
  })

  it('answers 500 when the sign-in fails', async () => {
    signInWithPassword.mockResolvedValue({ data: { user: null, session: null }, error: { code: 'invalid_credentials' } })
    const response = await (await load()).POST(post({ email: EMAIL }))
    expect(response.status).toBe(500)
    expect((await response.json()).code).toBe('internal')
  })

  it('answers 500 when the user cannot be created', async () => {
    admin.createUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError', status: 500 } })
    const response = await (await load()).POST(post({ email: EMAIL }))
    expect(response.status).toBe(500)
    expect(signInWithPassword).not.toHaveBeenCalled()
  })
})
