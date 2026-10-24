import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OAuth callback (docs/ARCHITECTURE.md section 7 and section 11 T17; REVIEW-1
 * R1-10). The Supabase server client is replaced by a fake.
 */
const exchangeCodeForSession = vi.fn()
const createClient = vi.fn(async () => ({ auth: { exchangeCodeForSession } }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))

const route = await import('./route')

const APP = 'https://prompt-piggy.vercel.app'

function callback(query: string): NextRequest {
  return new NextRequest(`${APP}/auth/callback${query}`)
}

beforeEach(() => {
  exchangeCodeForSession.mockReset()
  exchangeCodeForSession.mockResolvedValue({ data: {}, error: null })
  createClient.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('route config', () => {
  it('runs on the Node.js runtime and is never cached', () => {
    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

describe('a successful exchange', () => {
  it('exchanges the code and redirects to next', async () => {
    const response = await route.GET(callback('?code=good-code&next=/me?x=1'))
    expect(exchangeCodeForSession).toHaveBeenCalledWith('good-code')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${APP}/me?x=1`)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('redirects to /play without next', async () => {
    const response = await route.GET(callback('?code=good-code'))
    expect(response.headers.get('location')).toBe(`${APP}/play`)
  })

  it.each([
    ['another host', '//evil.com'],
    ['a scheme', 'https://evil.com'],
    ['slash backslash', '/\\evil.com'],
    ['an encoded slash', '/%2F/evil.com'],
    ['an encoded tab', '/%09/evil.com'],
    ['encoded CR LF', '/%0d%0a//evil.com'],
    ['a dot segment', '/.//evil.com'],
  ])('ignores a next with %s and redirects to /play', async (_label, next) => {
    const response = await route.GET(callback(`?code=good-code&next=${encodeURIComponent(next)}`))
    expect(response.headers.get('location')).toBe(`${APP}/play`)
  })

  it('stays on the origin it was called on', async () => {
    const preview = 'https://prompt-piggy-git-feature-kurt.vercel.app'
    const response = await route.GET(new NextRequest(`${preview}/auth/callback?code=c&next=/play`))
    expect(response.headers.get('location')).toBe(`${preview}/play`)
  })

  it('ignores X-Forwarded-Host', async () => {
    const request = new NextRequest(`${APP}/auth/callback?code=c&next=/play`, {
      headers: { 'x-forwarded-host': 'evil.com' },
    })
    expect((await route.GET(request)).headers.get('location')).toBe(`${APP}/play`)
  })
})

describe('failures land on /auth/error', () => {
  it('when the code is bad', async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null },
      error: { name: 'AuthApiError', code: 'bad_code_verifier', message: 'echo of request data' },
    })
    const response = await route.GET(callback('?code=bad&next=/play'))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${APP}/auth/error`)
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('echo of request data')
  })

  it('when there is no code, without calling Supabase', async () => {
    const response = await route.GET(callback('?error=access_denied&error_description=nope'))
    expect(response.headers.get('location')).toBe(`${APP}/auth/error`)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('when the code is empty or too long', async () => {
    for (const query of ['?code=', `?code=${'a'.repeat(513)}`]) {
      expect((await route.GET(callback(query))).headers.get('location')).toBe(`${APP}/auth/error`)
    }
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
  })

  it('when the exchange throws (Supabase unreachable)', async () => {
    exchangeCodeForSession.mockRejectedValue(new Error('fetch failed'))
    expect((await route.GET(callback('?code=c'))).headers.get('location')).toBe(`${APP}/auth/error`)
  })

  it('when Supabase is not configured', async () => {
    createClient.mockRejectedValueOnce(new Error('Supabase is not configured'))
    expect((await route.GET(callback('?code=c'))).headers.get('location')).toBe(`${APP}/auth/error`)
  })

  it('never redirects to next after a failure', async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: { name: 'AuthApiError' } })
    const response = await route.GET(callback('?code=bad&next=/me'))
    expect(response.headers.get('location')).toBe(`${APP}/auth/error`)
  })
})
