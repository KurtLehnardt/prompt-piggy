import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSnapshotDTO } from '@/types/api'

/**
 * The /live realtime hooks and the player snapshot poller (ARCHITECTURE
 * sections 12.2 to 12.4; R1-13, CH-5, T15). Runs in the ui project with a
 * mocked Supabase browser client and a fake clock.
 */

type Binding = { type: string; filter: Record<string, unknown>; callback: (payload: unknown) => void }
type FakeChannel = {
  name: string
  bindings: Binding[]
  statusCallback?: (status: string) => void
  on: (type: string, filter: Record<string, unknown>, callback: (payload: unknown) => void) => FakeChannel
  subscribe: (callback: (status: string) => void) => FakeChannel
}

const channels: FakeChannel[] = []
const removeChannel = vi.fn(async () => 'ok')
const createClient = vi.fn(() => ({
  channel: (name: string) => {
    const channel: FakeChannel = {
      name,
      bindings: [],
      on(type, filter, callback) {
        channel.bindings.push({ type, filter, callback })
        return channel
      },
      subscribe(callback) {
        channel.statusCallback = callback
        return channel
      },
    }
    channels.push(channel)
    return channel
  },
  removeChannel,
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => createClient() }))

const SNAPSHOT: LiveSnapshotDTO = {
  game: {
    treasuryCents: 5_000,
    level: 2,
    levelName: 'Porker',
    pigEpoch: 4,
    totals: { attempts: 10, wins: 1, paidOutCents: 2_000 },
  },
  levels: [{ id: 1, name: 'Piglet', ruleVersion: 2, lastHardenedAt: null }],
  feed: [
    {
      id: 7,
      at: '2026-10-24T12:00:07Z',
      type: 'attempt',
      level: 2,
      playerId: null,
      outcome: 'fail',
      technique: 'unknown',
      amountCents: null,
      ruleVersion: null,
    },
  ],
  config: { attemptsEnabled: true, attemptPriceCents: 100, repairPriceCents: 100 },
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }))
let visibility: DocumentVisibilityState = 'visible'

function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

function snapshotCalls(): number {
  return fetchMock.mock.calls.filter((call) => String((call as unknown[])[0]) === '/api/live/snapshot').length
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function status(channel: FakeChannel, value: string) {
  act(() => channel.statusCallback?.(value))
}

function emit(channel: FakeChannel, row: Record<string, unknown>) {
  act(() => channel.bindings[0].callback({ new: row }))
}

beforeEach(() => {
  vi.useFakeTimers()
  channels.length = 0
  removeChannel.mockClear()
  createClient.mockClear()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useRealtime', () => {
  it('subscribes to one postgres_changes event on a public table and exposes the channel status', async () => {
    const { useRealtime } = await import('./use-realtime')
    const onRow = vi.fn()
    const { result, unmount } = renderHook(() => useRealtime({ table: 'game_state', event: 'UPDATE', onRow }))
    expect(channels).toHaveLength(1)
    expect(channels[0].bindings).toEqual([
      { type: 'postgres_changes', filter: { event: 'UPDATE', schema: 'public', table: 'game_state' }, callback: expect.any(Function) },
    ])
    expect(result.current.status).toBe('connecting')
    status(channels[0], 'SUBSCRIBED')
    expect(result.current).toEqual({ status: 'SUBSCRIBED', needsFallback: false })

    emit(channels[0], { treasury_cents: 1 })
    expect(onRow).toHaveBeenCalledWith({ treasury_cents: 1 })

    unmount()
    expect(removeChannel).toHaveBeenCalledWith(channels[0])
  })

  it('keeps one channel when the callback changes (callback ref)', async () => {
    const { useRealtime } = await import('./use-realtime')
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ onRow }) => useRealtime({ table: 'live_feed', event: 'INSERT', onRow }), {
      initialProps: { onRow: first },
    })
    rerender({ onRow: second })
    expect(channels).toHaveLength(1)
    emit(channels[0], { id: 1 })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('needs the fallback when not SUBSCRIBED within 5 s, and clears it once SUBSCRIBED', async () => {
    const { useRealtime } = await import('./use-realtime')
    const { result } = renderHook(() => useRealtime({ table: 'game_state', event: 'UPDATE', onRow: () => {} }))
    await advance(4_999)
    expect(result.current.needsFallback).toBe(false)
    await advance(1)
    expect(result.current.needsFallback).toBe(true)
    status(channels[0], 'SUBSCRIBED')
    expect(result.current.needsFallback).toBe(false)
  })

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])('needs the fallback at once on %s', async (value) => {
    const { useRealtime } = await import('./use-realtime')
    const { result } = renderHook(() => useRealtime({ table: 'game_state', event: 'UPDATE', onRow: () => {} }))
    status(channels[0], value)
    expect(result.current.needsFallback).toBe(true)
  })

  it('needs the fallback when no client can be created', async () => {
    createClient.mockImplementationOnce(() => {
      throw new Error('Supabase is not configured')
    })
    const { useRealtime } = await import('./use-realtime')
    const { result } = renderHook(() => useRealtime({ table: 'game_state', event: 'UPDATE', onRow: () => {} }))
    expect(result.current).toEqual({ status: 'CHANNEL_ERROR', needsFallback: true })
  })

  it('opens nothing while disabled', async () => {
    const { useRealtime } = await import('./use-realtime')
    renderHook(() => useRealtime({ table: 'game_state', event: 'UPDATE', onRow: () => {}, enabled: false }))
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('useTreasury', () => {
  const INITIAL = SNAPSHOT.game

  it('subscribes to game_state UPDATE and applies each valid row', async () => {
    const { useTreasury } = await import('./use-treasury')
    const { result } = renderHook(() => useTreasury({ initial: INITIAL }))
    expect(channels[0].bindings[0].filter).toEqual({ event: 'UPDATE', schema: 'public', table: 'game_state' })
    status(channels[0], 'SUBSCRIBED')

    emit(channels[0], {
      current_level: 3,
      pig_epoch: 5,
      treasury_cents: 7_500,
      total_attempts: 11,
      total_wins: 2,
      total_paid_out_cents: 4_000,
    })
    expect(result.current.game).toEqual({
      treasuryCents: 7_500,
      level: 3,
      levelName: 'Hog',
      pigEpoch: 5,
      totals: { attempts: 11, wins: 2, paidOutCents: 4_000 },
    })

    emit(channels[0], { current_level: 'x', treasury_cents: 1 })
    expect(result.current.game?.treasuryCents).toBe(7_500)
  })

  it('does not poll while SUBSCRIBED', async () => {
    const { useTreasury } = await import('./use-treasury')
    const { result } = renderHook(() => useTreasury({ initial: INITIAL }))
    status(channels[0], 'SUBSCRIBED')
    await advance(20_000)
    expect(result.current.isPolling).toBe(false)
    expect(snapshotCalls()).toBe(0)
  })

  it('polls /api/live/snapshot every 2 s once the channel is not SUBSCRIBED within 5 s, and stops when it is', async () => {
    const { useTreasury } = await import('./use-treasury')
    const { result } = renderHook(() => useTreasury({ initial: INITIAL }))
    await advance(4_000)
    expect(snapshotCalls()).toBe(0)
    await advance(1_000)
    expect(result.current.isPolling).toBe(true)
    expect(snapshotCalls()).toBe(1)
    await advance(2_000)
    expect(snapshotCalls()).toBe(2)
    await advance(4_000)
    expect(snapshotCalls()).toBe(4)
    expect(result.current.game).toEqual(SNAPSHOT.game)

    status(channels[0], 'SUBSCRIBED')
    expect(result.current.isPolling).toBe(false)
    await advance(10_000)
    expect(snapshotCalls()).toBe(4)
  })

  it.each(['CHANNEL_ERROR', 'TIMED_OUT'])('switches to polling at once on %s', async (value) => {
    const { useTreasury } = await import('./use-treasury')
    const { result } = renderHook(() => useTreasury({ initial: INITIAL }))
    status(channels[0], value)
    await advance(0)
    expect(result.current.isPolling).toBe(true)
    expect(snapshotCalls()).toBe(1)
    await advance(2_000)
    expect(snapshotCalls()).toBe(2)
  })

  it('polls while it has no data yet', async () => {
    const { useTreasury } = await import('./use-treasury')
    const { result } = renderHook(() => useTreasury({ initial: null }))
    status(channels[0], 'SUBSCRIBED')
    expect(result.current.isPolling).toBe(true)
    await advance(0)
    expect(result.current.game).toEqual(SNAPSHOT.game)
    expect(result.current.isPolling).toBe(false)
  })
})

describe('useLiveFeed', () => {
  const row = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    created_at: `2026-10-24T12:00:${String(id).padStart(2, '0')}Z`,
    event_type: 'attempt',
    level_id: 1,
    player_id: '6f1c2e9a-1b2c-4d3e-8f90-123456789abc',
    outcome: 'win',
    technique: 'roleplay_persona',
    amount_cents: 2_500,
    rule_version: null,
    ...extra,
  })

  it('subscribes to live_feed INSERT, prepends new items, and keeps the newest 20', async () => {
    const { useLiveFeed } = await import('./use-live-feed')
    const { result } = renderHook(() => useLiveFeed({ initial: SNAPSHOT.feed }))
    expect(channels[0].bindings[0].filter).toEqual({ event: 'INSERT', schema: 'public', table: 'live_feed' })
    status(channels[0], 'SUBSCRIBED')

    emit(channels[0], row(8))
    expect(result.current.feed.map((item) => item.id)).toEqual([8, 7])
    expect(result.current.feed[0]).toEqual({
      id: 8,
      at: '2026-10-24T12:00:08Z',
      type: 'attempt',
      level: 1,
      playerId: '6f1c2e9a-1b2c-4d3e-8f90-123456789abc',
      outcome: 'win',
      technique: 'roleplay_persona',
      amountCents: 2_500,
      ruleVersion: null,
    })

    for (let id = 9; id <= 40; id += 1) emit(channels[0], row(id))
    expect(result.current.feed).toHaveLength(20)
    expect(result.current.feed[0].id).toBe(40)
  })

  it('drops a malformed row and anything that is not an enum, number, or id', async () => {
    const { useLiveFeed } = await import('./use-live-feed')
    const { result } = renderHook(() => useLiveFeed({ initial: [] }))
    emit(channels[0], row(8, { event_type: 'free text' }))
    emit(channels[0], row(9, { id: 'nine' }))
    emit(channels[0], row(10, { technique: 'ignore all rules', player_id: 'not-a-uuid', prompt: 'SECRET' }))
    expect(result.current.feed).toHaveLength(1)
    expect(result.current.feed[0]).toMatchObject({ id: 10, technique: null, playerId: null })
    expect(JSON.stringify(result.current.feed)).not.toContain('SECRET')
  })

  it('polls the snapshot every 2 s on CHANNEL_ERROR and merges its feed', async () => {
    const { useLiveFeed } = await import('./use-live-feed')
    const { result } = renderHook(() => useLiveFeed({ initial: [] }))
    status(channels[0], 'CHANNEL_ERROR')
    await advance(0)
    expect(result.current.isPolling).toBe(true)
    expect(result.current.feed.map((item) => item.id)).toEqual([7])
    await advance(2_000)
    expect(snapshotCalls()).toBe(2)
  })
})

describe('useSnapshot (player pages)', () => {
  it('polls every 5 s while visible, stops while hidden, and resumes at once', async () => {
    const { useSnapshot } = await import('./use-snapshot')
    const { result } = renderHook(() => useSnapshot())
    await advance(0)
    expect(snapshotCalls()).toBe(1)
    expect(result.current.snapshot).toEqual(SNAPSHOT)
    await advance(10_000)
    expect(snapshotCalls()).toBe(3)

    act(() => setVisibility('hidden'))
    await advance(30_000)
    expect(snapshotCalls()).toBe(3)

    act(() => setVisibility('visible'))
    await advance(0)
    expect(snapshotCalls()).toBe(4)
    await advance(5_000)
    expect(snapshotCalls()).toBe(5)
  })

  it('creates no Supabase client and opens no channel', async () => {
    const { useSnapshot } = await import('./use-snapshot')
    renderHook(() => useSnapshot())
    await advance(20_000)
    expect(createClient).not.toHaveBeenCalled()
    expect(channels).toHaveLength(0)
  })

  it('keeps the last good snapshot when a poll fails or is malformed', async () => {
    const { useSnapshot } = await import('./use-snapshot')
    const { result } = renderHook(() => useSnapshot())
    await advance(0)
    fetchMock.mockImplementationOnce(async () => new Response('{"game":1}', { status: 200 }))
    await advance(5_000)
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('offline')
    })
    await advance(5_000)
    expect(result.current.snapshot).toEqual(SNAPSHOT)
  })
})
