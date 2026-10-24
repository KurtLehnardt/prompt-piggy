import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sign-out (docs/ARCHITECTURE.md section 7; R1-04; PR #6 review, M5: branch
 * on assertSameOrigin and test a cross-origin POST). The Supabase server
 * client is replaced by a fake. Each test re-imports the route so the cached
 * server settings start empty.
 */
const signOut = vi.fn()
const createClient = vi.fn(async () => ({ auth: { signOut } }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))

const APP = 'https://prompt-piggy.vercel.app'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  for (const name of ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL']) vi.stubEnv(name, undefined)
  signOut.mockReset()
  signOut.mockResolvedValue({ error: null })
  createClient.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function load() {
  return import('./route')
}

function post(origin: string | null): NextRequest {
  const headers = new Headers()
  if (origin !== null) headers.set('origin', origin)
  return new NextRequest(`${APP}/auth/signout`, { method: 'POST', headers })
}

describe('POST /auth/signout', () => {
  it('runs on the Node.js runtime', async () => {
    expect((await load()).runtime).toBe('nodejs')
  })

  it('signs out a same-origin POST and redirects to /', async () => {
    const response = await (await load()).POST(post(APP))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${APP}/`)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it.each([
    ['another site', 'https://evil.example'],
    ['a look-alike host', 'https://prompt-piggy.vercel.app.evil.example'],
    ['http instead of https', 'http://prompt-piggy.vercel.app'],
    ['Origin: null', 'null'],
    ['no Origin header', null],
  ])('answers 403 forbidden for a POST from %s and leaves the session alone', async (_label, origin) => {
    const response = await (await load()).POST(post(origin))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'You are not allowed to do that.', code: 'forbidden' })
    expect(createClient).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('answers 403 when NEXT_PUBLIC_APP_URL is unset (fails closed)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined)
    expect((await (await load()).POST(post(APP))).status).toBe(403)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('still redirects to / when the revoke request fails', async () => {
    signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError', code: undefined } })
    const response = await (await load()).POST(post(APP))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${APP}/`)
  })

  it('answers 503 when Supabase is not configured', async () => {
    createClient.mockRejectedValueOnce(new Error('Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL.'))
    const response = await (await load()).POST(post(APP))
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('unavailable')
  })
})

describe('GET /auth/signout', () => {
  it('answers 405 and never signs out', async () => {
    const response = (await load()).GET()
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(signOut).not.toHaveBeenCalled()
  })
})
