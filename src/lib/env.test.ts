import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startsWithServerOnly, stripComments } from '@/test/source-imports'

/**
 * src/lib/env.ts (docs/ARCHITECTURE.md section 13; R1-14, R2-01, R2-07, CH-1,
 * CH-7). Each test re-imports the module so its cache starts empty.
 */
const SERVER_NAMES = [
  'OPENAI_API_KEY',
  'CRON_SECRET',
  'LIVE_VIEW_TOKEN',
  'ADMIN_EMAILS',
  'OPENAI_CORE_MODEL',
  'OPENAI_HARDENING_MODEL',
  'OPENAI_DECISIONS_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_CORE_MAX_OUTPUT_TOKENS',
  'OPENAI_HARDENING_MAX_OUTPUT_TOKENS',
  'OPENAI_DAILY_SPEND_CAP_USD',
  'OPENAI_ATTEMPT_SPEND_SHARE_PCT',
  'PIGGY_KILL_SWITCH',
  'RATE_LIMIT_ATTEMPTS_PER_MIN',
  'RATE_LIMIT_BURST',
  'RATE_LIMIT_ATTEMPTS_PER_DAY',
  'RATE_LIMIT_WALLET_PER_MIN',
  'MAX_PROMPT_CHARS',
  'HARDENING_MAX_JOBS_PER_HOUR',
  'HARDENING_MAX_JOBS_PER_USER_PER_HOUR',
  'HARDENING_TRAFFIC_WINDOW',
  'HARDENING_TRAFFIC_MAX_BPS',
  'RAW_PROMPT_RETENTION_DAYS',
  'PAYMENTS_MODE',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',
] as const

const SOURCE = readFileSync(path.join(__dirname, 'env.ts'), 'utf8')

beforeEach(() => {
  vi.resetModules()
  for (const name of SERVER_NAMES) vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function load() {
  return import('./env')
}

function set(values: Partial<Record<(typeof SERVER_NAMES)[number], string>>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
}

describe('module shape', () => {
  it("begins with import 'server-only'", () => {
    expect(startsWithServerOnly(SOURCE)).toBe(true)
  })

  it('imports with an empty environment without throwing (R1-14)', async () => {
    await expect(load()).resolves.toBeDefined()
  })

  it('reads nothing at import time: an invalid value only throws once getEnv() runs', async () => {
    set({ MAX_PROMPT_CHARS: 'not-a-number' })
    const env = await load()
    expect(() => env.getEnv()).toThrow(env.ServerEnvError)
  })

  it('does not read the Supabase variables, which src/lib/supabase reads', () => {
    expect(stripComments(SOURCE)).not.toMatch(/SUPABASE/)
  })

  it('defines no removed or out-of-scope names (CH-1, R2-S3)', () => {
    const code = stripComments(SOURCE)
    for (const name of ['OPENAI_DECISIONS_FALLBACK', 'PENALTY_BASE_PCT', 'PENALTY_MAX_PCT', 'LOCK_CAP', 'GOLDEN_']) {
      expect(code).not.toContain(name)
    }
  })

  it('reads each variable with a literal process.env.NAME expression', () => {
    const code = stripComments(SOURCE)
    for (const name of SERVER_NAMES) {
      expect(code).toContain(`process.env.${name}`)
    }
    expect(code).not.toMatch(/process\.env\[/)
  })
})

describe('defaults with an empty environment', () => {
  it('parses every server name with the section 13 defaults', async () => {
    const { getEnv } = await load()
    const env = getEnv()
    expect(Object.keys(env).sort()).toEqual([...SERVER_NAMES].sort())
    expect(env).toEqual({
      OPENAI_API_KEY: undefined,
      CRON_SECRET: undefined,
      LIVE_VIEW_TOKEN: undefined,
      ADMIN_EMAILS: [],
      OPENAI_CORE_MODEL: 'gpt-6-luna',
      OPENAI_HARDENING_MODEL: 'gpt-6.1-sol',
      OPENAI_DECISIONS_MODEL: 'gpt-6-luna',
      OPENAI_REASONING_EFFORT: 'minimal',
      OPENAI_CORE_MAX_OUTPUT_TOKENS: 1024,
      OPENAI_HARDENING_MAX_OUTPUT_TOKENS: 600,
      OPENAI_DAILY_SPEND_CAP_USD: 25,
      OPENAI_ATTEMPT_SPEND_SHARE_PCT: 80,
      PIGGY_KILL_SWITCH: false,
      RATE_LIMIT_ATTEMPTS_PER_MIN: 6,
      RATE_LIMIT_BURST: 3,
      RATE_LIMIT_ATTEMPTS_PER_DAY: 150,
      RATE_LIMIT_WALLET_PER_MIN: 10,
      MAX_PROMPT_CHARS: 2000,
      HARDENING_MAX_JOBS_PER_HOUR: 30,
      HARDENING_MAX_JOBS_PER_USER_PER_HOUR: 3,
      HARDENING_TRAFFIC_WINDOW: 500,
      HARDENING_TRAFFIC_MAX_BPS: 100,
      RAW_PROMPT_RETENTION_DAYS: 30,
      PAYMENTS_MODE: 'mock',
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
    })
  })

  it('treats empty values as unset, as in a copied .env.example', async () => {
    for (const name of SERVER_NAMES) vi.stubEnv(name, '')
    const { getEnv } = await load()
    expect(getEnv().MAX_PROMPT_CHARS).toBe(2000)
    expect(getEnv().ADMIN_EMAILS).toEqual([])
    expect(getEnv().OPENAI_API_KEY).toBeUndefined()
  })

  it('caches the parsed result and freezes it', async () => {
    const { getEnv } = await load()
    const first = getEnv()
    vi.stubEnv('MAX_PROMPT_CHARS', '100')
    expect(getEnv()).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.ADMIN_EMAILS)).toBe(true)
  })
})

describe('bounds', () => {
  it.each([
    ['MAX_PROMPT_CHARS', '0', false],
    ['MAX_PROMPT_CHARS', '1', true],
    ['MAX_PROMPT_CHARS', '4000', true],
    ['MAX_PROMPT_CHARS', '4001', false],
    ['MAX_PROMPT_CHARS', '12.5', false],
    ['MAX_PROMPT_CHARS', '-3', false],
    ['OPENAI_ATTEMPT_SPEND_SHARE_PCT', '9', false],
    ['OPENAI_ATTEMPT_SPEND_SHARE_PCT', '10', true],
    ['OPENAI_ATTEMPT_SPEND_SHARE_PCT', '100', true],
    ['OPENAI_ATTEMPT_SPEND_SHARE_PCT', '101', false],
    ['HARDENING_TRAFFIC_MAX_BPS', '9', false],
    ['HARDENING_TRAFFIC_MAX_BPS', '10', true],
    ['HARDENING_TRAFFIC_MAX_BPS', '1000', true],
    ['HARDENING_TRAFFIC_MAX_BPS', '1001', false],
    ['OPENAI_CORE_MAX_OUTPUT_TOKENS', '255', false],
    ['OPENAI_CORE_MAX_OUTPUT_TOKENS', '256', true],
    ['OPENAI_CORE_MAX_OUTPUT_TOKENS', '4096', true],
    ['OPENAI_CORE_MAX_OUTPUT_TOKENS', '4097', false],
    ['HARDENING_MAX_JOBS_PER_USER_PER_HOUR', '0', false],
    ['HARDENING_MAX_JOBS_PER_USER_PER_HOUR', '20', true],
    ['HARDENING_MAX_JOBS_PER_USER_PER_HOUR', '21', false],
    ['HARDENING_TRAFFIC_WINDOW', '0', true],
    ['OPENAI_DAILY_SPEND_CAP_USD', '12.5', true],
    ['OPENAI_DAILY_SPEND_CAP_USD', '0', false],
    ['OPENAI_DAILY_SPEND_CAP_USD', '1000', true],
    ['OPENAI_DAILY_SPEND_CAP_USD', '1000.01', false],
    ['OPENAI_DAILY_SPEND_CAP_USD', '1.234', false],
    ['VERCEL_ENV', 'staging', false],
    ['VERCEL_URL', 'https://not-a-host.example', false],
    ['VERCEL_URL', 'localhost:3000', true],
  ] as const)('%s=%s accepted: %s', async (name, value, accepted) => {
    set({ [name]: value })
    const { getEnv } = await load()
    if (accepted) expect(() => getEnv()).not.toThrow()
    else expect(() => getEnv()).toThrow(new RegExp(name))
  })

  it('parses numbers', async () => {
    set({ MAX_PROMPT_CHARS: '1500', OPENAI_DAILY_SPEND_CAP_USD: '12.5', HARDENING_TRAFFIC_WINDOW: '0' })
    const { getEnv } = await load()
    expect(getEnv().MAX_PROMPT_CHARS).toBe(1500)
    expect(getEnv().OPENAI_DAILY_SPEND_CAP_USD).toBe(12.5)
    expect(getEnv().HARDENING_TRAFFIC_WINDOW).toBe(0)
  })

  it.each(['omit', 'none', 'minimal', 'low', 'medium', 'high'])(
    'OPENAI_REASONING_EFFORT accepts %s (R2-01)',
    async (value) => {
      set({ OPENAI_REASONING_EFFORT: value })
      const { getEnv } = await load()
      expect(getEnv().OPENAI_REASONING_EFFORT).toBe(value)
    }
  )

  it('OPENAI_REASONING_EFFORT rejects anything else', async () => {
    set({ OPENAI_REASONING_EFFORT: 'maximum' })
    const { getEnv } = await load()
    expect(() => getEnv()).toThrow(/OPENAI_REASONING_EFFORT/)
  })

  it('PAYMENTS_MODE accepts only the literal mock (CH-4)', async () => {
    set({ PAYMENTS_MODE: 'mock' })
    expect((await load()).getEnv().PAYMENTS_MODE).toBe('mock')
    vi.resetModules()
    set({ PAYMENTS_MODE: 'stripe' })
    const { getEnv } = await load()
    expect(() => getEnv()).toThrow(/PAYMENTS_MODE/)
  })

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
  ] as const)('PIGGY_KILL_SWITCH=%s is %s', async (value, expected) => {
    set({ PIGGY_KILL_SWITCH: value })
    const { getEnv } = await load()
    expect(getEnv().PIGGY_KILL_SWITCH).toBe(expected)
  })

  it('PIGGY_KILL_SWITCH rejects an unrecognized value', async () => {
    set({ PIGGY_KILL_SWITCH: 'yes' })
    const { getEnv } = await load()
    expect(() => getEnv()).toThrow(/PIGGY_KILL_SWITCH/)
  })

  it('LIVE_VIEW_TOKEN is optional but at least 32 characters when set (R2-07)', async () => {
    set({ LIVE_VIEW_TOKEN: 'f'.repeat(31) })
    const short = await load()
    expect(() => short.getEnv()).toThrow(/LIVE_VIEW_TOKEN/)

    vi.resetModules()
    set({ LIVE_VIEW_TOKEN: 'f'.repeat(32) })
    expect((await load()).getEnv().LIVE_VIEW_TOKEN).toHaveLength(32)
  })
})

describe('ADMIN_EMAILS (CH-7)', () => {
  it('is trimmed, lowercased, and deduplicated', async () => {
    set({ ADMIN_EMAILS: ' Alice@Example.com, alice@example.COM ,bob@example.org,, ' })
    const { getEnv } = await load()
    expect(getEnv().ADMIN_EMAILS).toEqual(['alice@example.com', 'bob@example.org'])
  })

  it('may be empty', async () => {
    set({ ADMIN_EMAILS: ' , ' })
    const { getEnv } = await load()
    expect(getEnv().ADMIN_EMAILS).toEqual([])
  })

  it('rejects an entry that is not an email address', async () => {
    set({ ADMIN_EMAILS: 'alice@example.com,not-an-email' })
    const { getEnv } = await load()
    expect(() => getEnv()).toThrow(/ADMIN_EMAILS/)
  })
})

describe('error messages list names only', () => {
  it('an invalid value never appears in the message', async () => {
    const marker = 'fake-marker-value-7f3a'
    set({
      OPENAI_REASONING_EFFORT: marker,
      LIVE_VIEW_TOKEN: marker,
      OPENAI_CORE_MODEL: `${marker} with spaces`,
      OPENAI_API_KEY: `${marker}-key`,
    })
    const { getEnv, ServerEnvError } = await load()
    let caught: unknown
    try {
      getEnv()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ServerEnvError)
    const error = caught as InstanceType<typeof ServerEnvError>
    expect(error.names).toEqual(['LIVE_VIEW_TOKEN', 'OPENAI_CORE_MODEL', 'OPENAI_REASONING_EFFORT'])
    expect(error.message).toContain('LIVE_VIEW_TOKEN, OPENAI_CORE_MODEL, OPENAI_REASONING_EFFORT')
    expect(error.message).not.toContain(marker)
    expect(JSON.stringify(error)).not.toContain(marker)
  })

  it('requireEnv() throws naming each missing secret, and never a set value', async () => {
    const marker = 'fake-openai-key-marker-91c2'
    set({ OPENAI_API_KEY: marker })
    const { requireEnv, ServerEnvError } = await load()
    expect(requireEnv('OPENAI_API_KEY').OPENAI_API_KEY).toBe(marker)
    let caught: unknown
    try {
      requireEnv('OPENAI_API_KEY', 'CRON_SECRET', 'LIVE_VIEW_TOKEN')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ServerEnvError)
    const error = caught as InstanceType<typeof ServerEnvError>
    expect(error.message).toBe('Missing required server environment variables: CRON_SECRET, LIVE_VIEW_TOKEN.')
    expect(error.message).not.toContain(marker)
  })

  it('CRON_SECRET must be at least 16 characters when set', async () => {
    set({ CRON_SECRET: 'fake-short' })
    const { getEnv } = await load()
    expect(() => getEnv()).toThrow(/CRON_SECRET/)
  })
})
