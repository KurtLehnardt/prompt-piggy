import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importSpecifiers } from '@/test/source-imports'

/**
 * The public snapshot and health (ARCHITECTURE sections 7 and 12.3; R1-24,
 * R2-07, CH-6, P2-04). The anon client is replaced by a fake that records
 * what was read.
 */

type Result = { data: unknown; error: unknown }

const PLAYER = '6f1c2e9a-1b2c-4d3e-8f90-123456789abc'

function fakeClient(overrides: Partial<Record<'game' | 'feed' | 'levels' | 'config', Result>> = {}) {
  const calls: string[] = []
  const results = {
    game: {
      data: {
        current_level: 2,
        pig_epoch: 3,
        treasury_cents: 12_345,
        total_attempts: 40,
        total_wins: 2,
        total_paid_out_cents: 5_000,
        // Columns a careless select('*') would add; they must never reach the DTO.
        updated_at: '2026-10-24T12:00:00Z',
      },
      error: null,
    },
    feed: {
      data: [
        {
          id: 9,
          created_at: '2026-10-24T12:00:09Z',
          event_type: 'attempt',
          level_id: 2,
          player_id: PLAYER,
          outcome: 'fail',
          technique: 'roleplay_persona',
          amount_cents: null,
          rule_version: null,
          prompt: 'SECRET PROMPT',
          name: 'Leaky Name',
        },
        {
          id: 8,
          created_at: '2026-10-24T12:00:08Z',
          event_type: 'hardened',
          level_id: 1,
          player_id: null,
          outcome: null,
          technique: null,
          amount_cents: null,
          rule_version: 4,
        },
      ],
      error: null,
    },
    levels: {
      data: [
        { level_id: 1, name: 'Piglet', active_version: 4, last_hardened_at: '2026-10-24T12:00:08Z' },
        { level_id: 2, name: 'Porker', active_version: null, last_hardened_at: null },
      ],
      error: null,
    },
    config: {
      data: [{ attempts_enabled: true, attempt_price_cents: 100, repair_price_cents: 100 }],
      error: null,
    },
    ...overrides,
  }

  function query(table: string, result: Result) {
    const builder = {
      select(columns: string) {
        calls.push(`${table}.select(${columns})`)
        return builder
      },
      eq(column: string, value: unknown) {
        calls.push(`${table}.eq(${column},${String(value)})`)
        return builder
      },
      order(column: string, options: { ascending: boolean }) {
        calls.push(`${table}.order(${column},${options.ascending ? 'asc' : 'desc'})`)
        return builder
      },
      limit(count: number) {
        calls.push(`${table}.limit(${count})`)
        return Promise.resolve(result)
      },
      maybeSingle() {
        calls.push(`${table}.maybeSingle()`)
        return Promise.resolve(result)
      },
    }
    return builder
  }

  const client = {
    from(table: string) {
      return query(table, table === 'game_state' ? results.game : results.feed)
    },
    rpc(name: string) {
      calls.push(`rpc(${name})`)
      return Promise.resolve(name === 'get_level_status' ? results.levels : results.config)
    },
  }
  return { client, calls }
}

const FORBIDDEN_KEYS = [
  'players',
  'name',
  'avatarUrl',
  'prompt',
  'reply',
  'email',
  'rules',
  'block_keywords',
  'balance',
  'cracks',
]

/**
 * Every key in the value, as dotted paths with array indexes replaced by
 * "*", for example "levels.*.name".
 */
function allPaths(value: unknown, prefix = '', paths: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) allPaths(item, `${prefix}*.`, paths)
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      paths.add(`${prefix}${key}`)
      allPaths(child, `${prefix}${key}.`, paths)
    }
  }
  return paths
}

/**
 * The last segment of each path. LiveSnapshotDTO (src/types/api.ts, PP-04)
 * carries each level's public name as levels[].name, which is fixed seed
 * text from the levels table, not a player name; it is the only "name"
 * allowed, and the test pins it to the public level config.
 */
function allKeys(value: unknown): Set<string> {
  return new Set(
    [...allPaths(value)].filter((path) => path !== 'levels.*.name').map((path) => path.split('.').at(-1) ?? path)
  )
}

const createAnonClient = vi.fn()
vi.mock('@/lib/supabase/anon', () => ({ createAnonClient: () => createAnonClient() }))

beforeEach(() => {
  vi.resetModules()
  createAnonClient.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('buildLiveSnapshot', () => {
  it('builds LiveSnapshotDTO from game_state, the newest 20 feed rows, get_level_status, and get_public_config', async () => {
    const { client, calls } = fakeClient()
    const { buildLiveSnapshot } = await import('./snapshot')
    const snapshot = await buildLiveSnapshot(client as never)

    expect(snapshot).toEqual({
      game: {
        treasuryCents: 12_345,
        level: 2,
        levelName: 'Porker',
        pigEpoch: 3,
        totals: { attempts: 40, wins: 2, paidOutCents: 5_000 },
      },
      levels: [
        { id: 1, name: 'Piglet', ruleVersion: 4, lastHardenedAt: '2026-10-24T12:00:08Z' },
        { id: 2, name: 'Porker', ruleVersion: 0, lastHardenedAt: null },
      ],
      feed: [
        {
          id: 9,
          at: '2026-10-24T12:00:09Z',
          type: 'attempt',
          level: 2,
          playerId: PLAYER,
          outcome: 'fail',
          technique: 'roleplay_persona',
          amountCents: null,
          ruleVersion: null,
        },
        {
          id: 8,
          at: '2026-10-24T12:00:08Z',
          type: 'hardened',
          level: 1,
          playerId: null,
          outcome: null,
          technique: null,
          amountCents: null,
          ruleVersion: 4,
        },
      ],
      config: { attemptsEnabled: true, attemptPriceCents: 100, repairPriceCents: 100 },
    })
    expect(calls).toContain('live_feed.order(id,desc)')
    expect(calls).toContain('live_feed.limit(20)')
    expect(calls).toContain('game_state.eq(id,1)')
    expect(calls).toContain('rpc(get_level_status)')
    expect(calls).toContain('rpc(get_public_config)')
    expect(calls.some((call) => call.includes('select(*)'))).toBe(false)
  })

  it('serializes to JSON with no player list, name, avatar, prompt, reply, email, rules, keywords, balance, or cracks (CH-6)', async () => {
    const { client } = fakeClient()
    const { buildLiveSnapshot } = await import('./snapshot')
    const json = JSON.parse(JSON.stringify(await buildLiveSnapshot(client as never)))
    const keys = allKeys(json)
    for (const key of FORBIDDEN_KEYS) expect(keys.has(key), key).toBe(false)
    expect(JSON.stringify(json)).not.toContain('SECRET PROMPT')
    expect(JSON.stringify(json)).not.toContain('Leaky Name')
    expect(json.levels.map((level: { name: string }) => level.name)).toEqual(['Piglet', 'Porker'])
  })

  it('uses createAnonClient() by default', async () => {
    const { client } = fakeClient()
    createAnonClient.mockReturnValue(client)
    const { buildLiveSnapshot } = await import('./snapshot')
    await buildLiveSnapshot()
    expect(createAnonClient).toHaveBeenCalledTimes(1)
  })

  it('throws on a database error', async () => {
    const { client } = fakeClient({ feed: { data: null, error: { code: '42501', message: 'denied' } } })
    const { buildLiveSnapshot } = await import('./snapshot')
    await expect(buildLiveSnapshot(client as never)).rejects.toMatchObject({ code: '42501' })
  })

  it('imports the anon client and never the service-role client or its key', () => {
    const imports = importSpecifiers(readFileSync(new URL('./snapshot.ts', import.meta.url), 'utf8'))
    expect(imports).toContain('@/lib/supabase/anon')
    expect(imports).not.toContain('@/lib/supabase/admin')
    expect(imports).not.toContain('@/lib/supabase/env.server')
  })
})

describe('GET /api/live/snapshot', () => {
  async function load() {
    return import('@/app/api/live/snapshot/route')
  }

  it('declares the Node.js runtime and is dynamic', async () => {
    const route = await load()
    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
  })

  it('answers the snapshot with Cache-Control public, s-maxage=2, stale-while-revalidate=5', async () => {
    createAnonClient.mockReturnValue(fakeClient().client)
    const response = await (await load()).GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=2, stale-while-revalidate=5')
    const body = await response.json()
    expect(body.game.treasuryCents).toBe(12_345)
    expect(allKeys(body).has('players')).toBe(false)
  })

  it('takes no request, so the query string cannot change the answer', async () => {
    expect((await load()).GET.length).toBe(0)
  })

  it('answers 503 unavailable, uncached, when Supabase is not configured', async () => {
    createAnonClient.mockImplementation(() => {
      throw new Error('Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL.')
    })
    const response = await (await load()).GET()
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).code).toBe('unavailable')
  })
})

describe('GET /api/health', () => {
  async function load() {
    return import('@/app/api/health/route')
  }

  it('answers { ok, attemptsEnabled } with s-maxage=5 through the anon client', async () => {
    createAnonClient.mockReturnValue(fakeClient().client)
    const route = await load()
    expect(route.runtime).toBe('nodejs')
    const response = await route.GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=5')
    expect(await response.json()).toEqual({ ok: true, attemptsEnabled: true })
    expect(createAnonClient).toHaveBeenCalledTimes(1)
  })

  it('reports attemptsEnabled false when the config says so', async () => {
    createAnonClient.mockReturnValue(
      fakeClient({
        config: { data: [{ attempts_enabled: false, attempt_price_cents: 100, repair_price_cents: 100 }], error: null },
      }).client
    )
    expect(await (await (await load()).GET()).json()).toEqual({ ok: true, attemptsEnabled: false })
  })

  it('imports neither the service-role client nor its key', () => {
    for (const file of ['../../app/api/health/route.ts', '../../app/api/live/snapshot/route.ts']) {
      const imports = importSpecifiers(readFileSync(new URL(file, import.meta.url), 'utf8'))
      expect(imports).not.toContain('@/lib/supabase/admin')
      expect(imports).not.toContain('@/lib/supabase/env.server')
    }
  })
})
