import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The signed-in heartbeat (ARCHITECTURE sections 7 and 9.7; T27; R2-S1,
 * R3-02; PR #6 review, M5). The cookie-bound server client and the
 * service-role client are fakes. Each test re-imports the route, so its
 * per-instance list memo starts empty.
 */
const APP = 'https://prompt-piggy.vercel.app'
const CALLER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const HASH = '0123456789abcdef0123456789abcdef'
const NEXT_HASH = 'fedcba9876543210fedcba9876543210'

function player(index: number, auraBps = 0) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Player ${index}`,
    avatarUrl: null,
    auraBps,
    lastSeenBucket: 0,
  }
}

// require-user.ts imports redirect() for pages; the react-server test condition cannot load next/navigation.
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`)
  },
}))

const getUser = vi.fn()
const createClient = vi.fn(async () => ({ auth: { getUser } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))

const rpc = vi.fn()
const createAdminClient = vi.fn(() => ({ rpc }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  for (const name of ['VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL']) vi.stubEnv(name, undefined)
  getUser.mockReset()
  getUser.mockResolvedValue({ data: { user: { id: CALLER, is_anonymous: false } }, error: null })
  createClient.mockClear()
  rpc.mockReset()
  rpc.mockResolvedValue({ data: [{ list_hash: HASH, players: [player(1)] }], error: null })
  createAdminClient.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function load() {
  return import('./route')
}

function ping(options: { origin?: string | null; query?: string; body?: string } = {}): NextRequest {
  const headers = new Headers()
  const origin = options.origin === undefined ? APP : options.origin
  if (origin !== null) headers.set('origin', origin)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return new NextRequest(`${APP}/api/presence/ping${options.query ?? ''}`, {
    method: 'POST',
    headers,
    body: options.body,
  })
}

describe('POST /api/presence/ping', () => {
  it('declares the Node.js runtime and is dynamic', async () => {
    const route = await load()
    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
  })

  it('pings for the caller through the service role and returns LivePlayersDTO, never cached', async () => {
    const response = await (await load()).POST(ping())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ unchanged: false, listHash: HASH, players: [player(1)] })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('presence_ping', { p_user_id: CALLER, p_window_seconds: 120, p_limit: 150 })
  })

  it('pings only the caller when the body names another user (T27)', async () => {
    const body = JSON.stringify({ userId: OTHER, user_id: OTHER, p_user_id: OTHER, name: 'Spoof', auraBps: 10000 })
    const response = await (await load()).POST(ping({ body, query: `?user=${OTHER}` }))
    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1].p_user_id).toBe(CALLER)
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(OTHER)
  })

  it.each([
    ['another site', 'https://evil.example'],
    ['a look-alike host', 'https://prompt-piggy.vercel.app.evil.example'],
    ['Origin: null', 'null'],
    ['no Origin header', null],
  ])('answers 403 forbidden for a POST from %s and pings nobody (M5)', async (_label, origin) => {
    const response = await (await load()).POST(ping({ origin }))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'You are not allowed to do that.', code: 'forbidden' })
    expect(createClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 401 for a signed-out visitor', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await (await load()).POST(ping())
    expect(response.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 401 for an anonymous session (R2-16)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: CALLER, is_anonymous: true } }, error: null })
    const response = await (await load()).POST(ping())
    expect(response.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers unchanged with no list when h matches the current hash (R3-02)', async () => {
    const response = await (await load()).POST(ping({ query: `?h=${HASH}` }))
    expect(await response.json()).toEqual({ unchanged: true, listHash: HASH })
  })

  it('sends the instance memo hash to SQL and reuses the memo when SQL says unchanged', async () => {
    const route = await load()
    await route.POST(ping())
    rpc.mockResolvedValue({ data: [], error: null })
    const second = await route.POST(ping())
    expect(rpc.mock.calls[1][1]).toEqual({ p_user_id: CALLER, p_window_seconds: 120, p_limit: 150, p_known_hash: HASH })
    expect(await second.json()).toEqual({ unchanged: false, listHash: HASH, players: [player(1)] })

    const third = await route.POST(ping({ query: `?h=${HASH}` }))
    expect(await third.json()).toEqual({ unchanged: true, listHash: HASH })
  })

  it('answers the new list when it changed since the client hash', async () => {
    const route = await load()
    rpc.mockResolvedValue({ data: [{ list_hash: NEXT_HASH, players: [player(1), player(2)] }], error: null })
    const response = await route.POST(ping({ query: `?h=${HASH}` }))
    expect(await response.json()).toEqual({ unchanged: false, listHash: NEXT_HASH, players: [player(1), player(2)] })
  })

  it('caps the strip at 30 players, highest aura first, in a stable order', async () => {
    const many = Array.from({ length: 45 }, (_, index) => player(index + 1, index === 44 ? 9000 : 0))
    rpc.mockResolvedValue({ data: [{ list_hash: HASH, players: [...many].reverse() }], error: null })
    const body = await (await (await load()).POST(ping())).json()
    expect(body.players).toHaveLength(30)
    expect(body.players[0].id).toBe(player(45).id)
    expect(body.players.slice(1).map((p: { id: string }) => p.id)).toEqual(many.slice(0, 29).map((p) => p.id))
  })

  it('maps a forbidden presence_ping (no wallet) to 403', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PT403', message: 'forbidden: presence_ping needs a player with a wallet' } })
    const response = await (await load()).POST(ping())
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('forbidden')
  })

  it('answers 500 without internals for a malformed row', async () => {
    rpc.mockResolvedValue({ data: [{ list_hash: 'not-a-hash', players: 'nope' }], error: null })
    const response = await (await load()).POST(ping())
    expect(response.status).toBe(500)
    expect((await response.json()).code).toBe('internal')
  })

  it('drops keys outside LivePlayerDTO', async () => {
    rpc.mockResolvedValue({
      data: [{ list_hash: HASH, players: [{ ...player(1), email: 'leak@example.com', balanceCents: 5 }] }],
      error: null,
    })
    const body = await (await (await load()).POST(ping())).json()
    expect(body.players).toEqual([player(1)])
  })
})
