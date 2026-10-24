import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The heartbeat and the /live wall poll (ARCHITECTURE section 9.7; R2-S1,
 * R3-02). A fake clock checks both cadences, and a mocked Supabase client
 * proves that no Realtime channel is ever created for the wall.
 */
const createClient = vi.fn()
vi.mock('@/lib/supabase/client', () => ({ createClient: () => createClient() }))

const HASH = '0123456789abcdef0123456789abcdef'
const PLAYER = {
  id: '6f1c2e9a-1b2c-4d3e-8f90-123456789abc',
  name: 'Ada L.',
  avatarUrl: null,
  auraBps: 1200,
  lastSeenBucket: 0,
}

let reply: () => Promise<Response>
const fetchMock = vi.fn((...args: [string, RequestInit?]) => (void args, reply()))
let visibility: DocumentVisibilityState = 'visible'

function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function calls(url: string) {
  return fetchMock.mock.calls.filter(([target]) => target.split('?')[0] === url)
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockClear()
  createClient.mockClear()
  reply = async () => new Response(JSON.stringify({ unchanged: false, listHash: HASH, players: [PLAYER] }), { status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('usePresencePing', () => {
  it('posts on mount and every 10 s while visible, with no body, and exposes the players', async () => {
    const { usePresencePing } = await import('./use-presence-ping')
    const { result } = renderHook(() => usePresencePing())
    await advance(0)
    expect(calls('/api/presence/ping')).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/presence/ping')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
    expect(result.current.players).toEqual([PLAYER])

    await advance(9_999)
    expect(calls('/api/presence/ping')).toHaveLength(1)
    await advance(1)
    expect(calls('/api/presence/ping')).toHaveLength(2)
    await advance(20_000)
    expect(calls('/api/presence/ping')).toHaveLength(4)
  })

  it('sends the last hash in h and keeps the list on an unchanged answer (R3-02)', async () => {
    const { usePresencePing } = await import('./use-presence-ping')
    const { result } = renderHook(() => usePresencePing())
    await advance(0)
    reply = async () => new Response(JSON.stringify({ unchanged: true, listHash: HASH }), { status: 200 })
    await advance(10_000)
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/presence/ping?h=${HASH}`)
    expect(result.current.players).toEqual([PLAYER])
  })

  it('stops while hidden and pings at once when visible again', async () => {
    const { usePresencePing } = await import('./use-presence-ping')
    renderHook(() => usePresencePing())
    await advance(0)
    act(() => setVisibility('hidden'))
    await advance(60_000)
    expect(calls('/api/presence/ping')).toHaveLength(1)
    act(() => setVisibility('visible'))
    await advance(0)
    expect(calls('/api/presence/ping')).toHaveLength(2)
    await advance(10_000)
    expect(calls('/api/presence/ping')).toHaveLength(3)
  })

  it('does not ping on mount while hidden', async () => {
    visibility = 'hidden'
    const { usePresencePing } = await import('./use-presence-ping')
    renderHook(() => usePresencePing())
    await advance(30_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows errors and keeps the last list', async () => {
    const { usePresencePing } = await import('./use-presence-ping')
    const { result } = renderHook(() => usePresencePing())
    await advance(0)
    reply = async () => {
      throw new TypeError('offline')
    }
    await advance(10_000)
    reply = async () => new Response('{"error":"x","code":"internal"}', { status: 500 })
    await advance(10_000)
    reply = async () => new Response('not json', { status: 200 })
    await advance(10_000)
    expect(result.current.players).toEqual([PLAYER])
    expect(calls('/api/presence/ping')).toHaveLength(4)
  })

  it('stops on unmount', async () => {
    const { usePresencePing } = await import('./use-presence-ping')
    const { unmount } = renderHook(() => usePresencePing())
    await advance(0)
    unmount()
    await advance(60_000)
    expect(calls('/api/presence/ping')).toHaveLength(1)
  })
})

describe('useLivePlayers (/live wall)', () => {
  it('polls GET /live/players every 3 s', async () => {
    const { useLivePlayers } = await import('./use-live-players')
    const { result } = renderHook(() => useLivePlayers())
    await advance(0)
    expect(calls('/live/players')).toHaveLength(1)
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
    expect(result.current.players).toEqual([PLAYER])
    await advance(2_999)
    expect(calls('/live/players')).toHaveLength(1)
    await advance(1)
    expect(calls('/live/players')).toHaveLength(2)
    await advance(9_000)
    expect(calls('/live/players')).toHaveLength(5)
  })

  it('reports a 401 so /live can say the link expired', async () => {
    reply = async () => new Response('{"error":"x","code":"unauthorized"}', { status: 401 })
    const { useLivePlayers } = await import('./use-live-players')
    const { result } = renderHook(() => useLivePlayers())
    await advance(0)
    expect(result.current).toEqual({ players: null, unauthorized: true })
  })

  it('creates no Supabase client or Realtime channel for the wall or the heartbeat', async () => {
    const { useLivePlayers } = await import('./use-live-players')
    const { usePresencePing } = await import('./use-presence-ping')
    renderHook(() => {
      useLivePlayers()
      usePresencePing()
    })
    await advance(60_000)
    expect(createClient).not.toHaveBeenCalled()
  })
})
