import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * REVIEW-1 R1-14: every Supabase module reads its environment when a client is
 * created, never when it is imported, so `next build` succeeds on a fresh
 * Vercel project that has no environment variables yet.
 */
const NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const

beforeEach(() => {
  vi.resetModules()
  for (const name of NAMES) vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('importing with an empty environment', () => {
  it.each([
    ['client', () => import('./client')],
    ['server', () => import('./server')],
    ['anon', () => import('./anon')],
    ['admin', () => import('./admin')],
    ['proxy', () => import('./proxy')],
    ['env', () => import('./env')],
    ['env.server', () => import('./env.server')],
  ])('%s imports without throwing', async (_name, load) => {
    await expect(load()).resolves.toBeDefined()
  })
})

describe('calling a factory with an empty environment', () => {
  it('client throws a clear error naming the variables', async () => {
    const { createClient } = await import('./client')
    expect(() => createClient()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \(or the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY\)/
    )
  })

  it('server rejects with a clear error before touching cookies', async () => {
    const { createClient } = await import('./server')
    await expect(createClient()).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })

  it('anon throws a clear error', async () => {
    const { createAnonClient } = await import('./anon')
    expect(() => createAnonClient()).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/)
  })

  it('admin throws a clear error naming both secret-key variables', async () => {
    const { createAdminClient } = await import('./admin')
    expect(() => createAdminClient()).toThrow(
      /SUPABASE_SECRET_KEY \(or the legacy SUPABASE_SERVICE_ROLE_KEY\)/
    )
  })

  it('admin does not fall back to the publishable or anon key', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake-project.supabase.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'fake-publishable-key')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-anon-key')
    const { createAdminClient } = await import('./admin')
    expect(() => createAdminClient()).toThrow(/SUPABASE_SECRET_KEY/)
  })
})

describe('environment variable names', () => {
  it.each([
    ['only the new names', { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fake-publishable-key' }, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
    ['only the legacy name', { NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' }, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    [
      'both names',
      { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fake-publishable-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' },
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ],
  ])('the publishable key resolves from %s', async (_label, env, expectedName) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const { resolveSupabasePublishableKey } = await import('./env')
    expect(resolveSupabasePublishableKey()?.name).toBe(expectedName)
  })

  it.each([
    ['only the new name', { SUPABASE_SECRET_KEY: 'fake-secret-key' }, 'SUPABASE_SECRET_KEY'],
    ['only the legacy name', { SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key' }, 'SUPABASE_SERVICE_ROLE_KEY'],
    [
      'both names',
      { SUPABASE_SECRET_KEY: 'fake-secret-key', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key' },
      'SUPABASE_SECRET_KEY',
    ],
  ])('the secret key resolves from %s', async (_label, env, expectedName) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const { resolveSupabaseSecretKey } = await import('./env.server')
    expect(resolveSupabaseSecretKey()?.name).toBe(expectedName)
  })

  it('treats an empty value as unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-anon-key')
    const { resolveSupabasePublishableKey } = await import('./env')
    expect(resolveSupabasePublishableKey()?.name).toBe('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  })

  it('names the missing public settings without values', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake-project.supabase.test')
    const { missingPublicSupabaseEnv } = await import('./env')
    expect(missingPublicSupabaseEnv()).toEqual([
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)',
    ])
  })
})

describe('calling a factory once the environment is set', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fake-project.supabase.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'fake-publishable-key')
    vi.stubEnv('SUPABASE_SECRET_KEY', 'fake-secret-key')
  })

  it('anon returns a client without a session', async () => {
    const { createAnonClient } = await import('./anon')
    const client = createAnonClient()
    expect(typeof client.from).toBe('function')
    await expect(client.auth.getSession()).resolves.toMatchObject({ data: { session: null } })
  })

  it('admin returns a client', async () => {
    const { createAdminClient } = await import('./admin')
    expect(typeof createAdminClient().from).toBe('function')
  })
})
