import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The projector gate (ARCHITECTURE sections 7 and 12.2; T32; R2-07, R3-10;
 * PR #6 review, M1): /live/enter, /live/players, and the /live page. The
 * service-role client, the snapshot, and next/headers are fakes. Each test
 * re-imports the modules so the cached server settings start empty.
 */
const APP = 'https://prompt-piggy.vercel.app'
const TOKEN = 'fake-projector-token-0123456789abcdef'
const HASH = '0123456789abcdef0123456789abcdef'
const PLAYER = {
  id: '6f1c2e9a-1b2c-4d3e-8f90-123456789abc',
  name: 'Ada L.',
  avatarUrl: 'https://lh3.googleusercontent.com/a/fake-avatar=s96-c',
  auraBps: 2500,
  lastSeenBucket: 0,
}

const rpc = vi.fn()
const createAdminClient = vi.fn(() => ({ rpc }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))

const buildLiveSnapshot = vi.fn()
vi.mock('@/lib/live/snapshot', () => ({ buildLiveSnapshot: () => buildLiveSnapshot() }))

// The client view pulls in next/image, which the react-server test condition cannot load.
vi.mock('@/components/live/live-projector', () => ({ LiveProjector: function LiveProjector() { return null } }))

const cookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
}))

let logged: unknown[][] = []

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('LIVE_VIEW_TOKEN', TOKEN)
  rpc.mockReset()
  createAdminClient.mockClear()
  buildLiveSnapshot.mockReset()
  cookieJar.clear()
  logged = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function expectNothingLogged(...secrets: string[]) {
  const text = JSON.stringify(logged)
  for (const secret of secrets) expect(text).not.toContain(secret)
}

async function validCookie(nowMs = Date.now()): Promise<string> {
  const { signProjectorCookie } = await import('@/lib/live/projector-cookie')
  return signProjectorCookie(TOKEN, nowMs)
}

describe('GET /live/enter', () => {
  async function load() {
    return import('./enter/route')
  }

  function enter(query: string): NextRequest {
    return new NextRequest(`${APP}/live/enter${query}`)
  }

  it('declares the Node.js runtime and is dynamic', async () => {
    const route = await load()
    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
  })

  it('sets the pp_live cookie and answers 303 to /live for the right token', async () => {
    const response = await (await load()).GET(enter(`?k=${TOKEN}`))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${APP}/live`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')

    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/^pp_live=v1\.\d{10,12}\.[A-Za-z0-9_-]{43};/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=strict/i)
    expect(setCookie).toMatch(/Path=\/live(;|$)/)
    expect(setCookie).toMatch(/Max-Age=43200/)
    expect(setCookie).not.toContain(TOKEN)
    expectNothingLogged(TOKEN)
  })

  it('drops every query parameter from the redirect', async () => {
    const response = await (await load()).GET(enter(`?k=${TOKEN}&next=https://evil.example`))
    expect(response.headers.get('location')).toBe(`${APP}/live`)
  })

  it('issues a cookie that /live/players accepts', async () => {
    const response = await (await load()).GET(enter(`?k=${TOKEN}`))
    const value = /pp_live=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1]
    const { hasProjectorAccess } = await import('@/lib/live/projector-cookie')
    expect(hasProjectorAccess(value)).toBe(true)
  })

  it.each([
    ['a wrong token', `?k=${TOKEN.slice(0, -1)}x`],
    ['a longer token', `?k=${TOKEN}x`],
    ['a missing token', ''],
    ['an empty token', '?k='],
    ['a token in another parameter', `?token=${TOKEN}`],
  ])('answers 404 with no cookie for %s', async (_label, query) => {
    const response = await (await load()).GET(enter(query))
    expect(response.status).toBe(404)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await response.json()).code).toBe('not_found')
    expectNothingLogged(TOKEN)
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('answers 404 with no cookie when LIVE_VIEW_TOKEN is %s, even for an empty k (fail closed)', async (_label, value) => {
    vi.stubEnv('LIVE_VIEW_TOKEN', value)
    const route = await load()
    for (const query of ['', '?k=', `?k=${TOKEN}`]) {
      const response = await route.GET(enter(query))
      expect(response.status).toBe(404)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
  })

  it('never logs the token or the k parameter', async () => {
    const route = await load()
    await route.GET(enter(`?k=${TOKEN}`))
    await route.GET(enter('?k=fake-wrong-guess-value-123456789012'))
    expect(logged).toEqual([])
  })
})

describe('GET /live/players', () => {
  async function load() {
    return import('./players/route')
  }

  function players(cookie: string | null, query = ''): NextRequest {
    const headers = new Headers()
    if (cookie !== null) headers.set('cookie', `pp_live=${cookie}`)
    return new NextRequest(`${APP}/live/players${query}`, { headers })
  }

  it('declares the Node.js runtime and is dynamic', async () => {
    const route = await load()
    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
  })

  it('returns LivePlayersDTO from get_live_players through the service role for a valid cookie', async () => {
    rpc.mockResolvedValue({ data: [{ list_hash: HASH, players: [{ ...PLAYER, email: 'leak@example.com' }] }], error: null })
    const response = await (await load()).GET(players(await validCookie()))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ unchanged: false, listHash: HASH, players: [PLAYER] })
    expect(rpc).toHaveBeenCalledWith('get_live_players', { p_window_seconds: 120, p_limit: 150 })
  })

  it('passes a well-formed h and answers unchanged with no list when it still matches (R3-02)', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const response = await (await load()).GET(players(await validCookie(), `?h=${HASH}`))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ unchanged: true, listHash: HASH })
    expect(rpc).toHaveBeenCalledWith('get_live_players', { p_window_seconds: 120, p_limit: 150, p_known_hash: HASH })
  })

  it('ignores a malformed h', async () => {
    rpc.mockResolvedValue({ data: [{ list_hash: HASH, players: [] }], error: null })
    await (await load()).GET(players(await validCookie(), '?h=not-a-hash'))
    expect(rpc).toHaveBeenCalledWith('get_live_players', { p_window_seconds: 120, p_limit: 150 })
  })

  it.each([
    ['no cookie', async () => null],
    ['a forged cookie', async () => 'v1.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['an expired cookie', async () => validCookie(Date.now() - 13 * 3600 * 1000)],
    [
      'a wrong-key cookie',
      async () => {
        const { signProjectorCookie } = await import('@/lib/live/projector-cookie')
        return signProjectorCookie('fake-other-projector-token-0123456789', Date.now())
      },
    ],
    ['the token itself as the cookie', async () => TOKEN],
  ])('answers 401 for %s and never calls the service role', async (_label, makeCookie) => {
    const response = await (await load()).GET(players(await makeCookie()))
    expect(response.status).toBe(401)
    expect((await response.json()).code).toBe('unauthorized')
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 401 for a valid cookie once LIVE_VIEW_TOKEN is unset', async () => {
    const cookie = await validCookie()
    vi.resetModules()
    vi.stubEnv('LIVE_VIEW_TOKEN', undefined)
    const response = await (await load()).GET(players(cookie))
    expect(response.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps a database error without leaking it', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'internal detail' } })
    const response = await (await load()).GET(players(await validCookie()))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('internal detail')
    expectNothingLogged('internal detail', TOKEN)
  })
})

describe('/live page', () => {
  async function render() {
    const page = await import('./page')
    return page.default()
  }

  it('renders only the closed screen without a cookie, and fetches nothing', async () => {
    const { LiveClosed } = await import('@/components/live/live-closed')
    const element = await render()
    expect(element.type).toBe(LiveClosed)
    expect(buildLiveSnapshot).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['a forged cookie', async () => 'v1.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['an expired cookie', async () => validCookie(Date.now() - 13 * 3600 * 1000)],
  ])('renders the closed screen for %s', async (_label, makeCookie) => {
    cookieJar.set('pp_live', await makeCookie())
    const { LiveClosed } = await import('@/components/live/live-closed')
    expect((await render()).type).toBe(LiveClosed)
    expect(buildLiveSnapshot).not.toHaveBeenCalled()
  })

  it('renders the projector view with the first snapshot for a valid cookie', async () => {
    cookieJar.set('pp_live', await validCookie())
    const snapshot = { game: { treasuryCents: 1 } }
    buildLiveSnapshot.mockResolvedValue(snapshot)
    const { LiveProjector } = await import('@/components/live/live-projector')
    const element = await render()
    expect(element.type).toBe(LiveProjector)
    expect(element.props).toEqual({ initial: snapshot })
  })

  it('still renders the projector view, without a first snapshot, when the snapshot fails', async () => {
    cookieJar.set('pp_live', await validCookie())
    buildLiveSnapshot.mockRejectedValue(new Error('down'))
    const element = await render()
    expect(element.props).toEqual({ initial: null })
  })

  it('renders the closed screen for every cookie while LIVE_VIEW_TOKEN is unset', async () => {
    cookieJar.set('pp_live', await validCookie())
    vi.resetModules()
    vi.stubEnv('LIVE_VIEW_TOKEN', undefined)
    const { LiveClosed } = await import('@/components/live/live-closed')
    expect((await render()).type).toBe(LiveClosed)
  })
})
