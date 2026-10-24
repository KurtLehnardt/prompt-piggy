import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importSpecifiers, startsWithServerOnly } from '@/test/source-imports'

/**
 * src/lib/ops/limits.ts and src/lib/ops/kill-switch.ts (docs/ARCHITECTURE.md
 * sections 9.4, 12.1, and 13; REVIEW-1 R1-09; REVIEW-2 R2-13; PR #6 review
 * M2; T16). Each test re-imports the modules so the env cache starts empty.
 */

const ENV_NAMES = [
  'RATE_LIMIT_BURST',
  'RATE_LIMIT_ATTEMPTS_PER_MIN',
  'RATE_LIMIT_ATTEMPTS_PER_DAY',
  'RATE_LIMIT_WALLET_PER_MIN',
  'MAX_PROMPT_CHARS',
  'OPENAI_DAILY_SPEND_CAP_USD',
  'OPENAI_ATTEMPT_SPEND_SHARE_PCT',
  'HARDENING_MAX_JOBS_PER_HOUR',
  'HARDENING_MAX_JOBS_PER_USER_PER_HOUR',
  'HARDENING_TRAFFIC_WINDOW',
  'HARDENING_TRAFFIC_MAX_BPS',
  'PIGGY_KILL_SWITCH',
] as const

beforeEach(() => {
  vi.resetModules()
  for (const name of ENV_NAMES) vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('module shape', () => {
  it.each(['limits.ts', 'kill-switch.ts'])("%s begins with import 'server-only' and reads no database", (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8')
    expect(startsWithServerOnly(source)).toBe(true)
    expect(importSpecifiers(source).filter((specifier) => specifier.includes('supabase'))).toEqual([])
    expect(source).not.toMatch(/\.rpc\(|\.from\(/)
  })
})

describe('getLimits', () => {
  it('returns the section 13 defaults', async () => {
    const { getLimits } = await import('./limits')
    expect(getLimits()).toEqual({
      burst: 3,
      perMin: 6,
      perDay: 150,
      walletPerMin: 10,
      maxPromptChars: 2000,
      dailyCapMicros: 25_000_000,
      attemptShareBps: 8000,
      jobsPerHour: 30,
      jobsPerUserPerHour: 3,
      trafficWindow: 500,
      trafficMaxBps: 100,
    })
  })

  it('reads every value from env', async () => {
    vi.stubEnv('RATE_LIMIT_BURST', '5')
    vi.stubEnv('RATE_LIMIT_ATTEMPTS_PER_MIN', '12')
    vi.stubEnv('RATE_LIMIT_ATTEMPTS_PER_DAY', '40')
    vi.stubEnv('RATE_LIMIT_WALLET_PER_MIN', '20')
    vi.stubEnv('MAX_PROMPT_CHARS', '1500')
    vi.stubEnv('OPENAI_DAILY_SPEND_CAP_USD', '12.34')
    vi.stubEnv('OPENAI_ATTEMPT_SPEND_SHARE_PCT', '75')
    vi.stubEnv('HARDENING_MAX_JOBS_PER_HOUR', '10')
    vi.stubEnv('HARDENING_MAX_JOBS_PER_USER_PER_HOUR', '2')
    vi.stubEnv('HARDENING_TRAFFIC_WINDOW', '0')
    vi.stubEnv('HARDENING_TRAFFIC_MAX_BPS', '250')
    const { getLimits } = await import('./limits')
    expect(getLimits()).toEqual({
      burst: 5,
      perMin: 12,
      perDay: 40,
      walletPerMin: 20,
      maxPromptChars: 1500,
      dailyCapMicros: 12_340_000,
      attemptShareBps: 7500,
      jobsPerHour: 10,
      jobsPerUserPerHour: 2,
      trafficWindow: 0,
      trafficMaxBps: 250,
    })
  })

  it('converts a $2.01 cap to exactly 2,010,000 integer micros (PR #6 review M2)', async () => {
    vi.stubEnv('OPENAI_DAILY_SPEND_CAP_USD', '2.01')
    const { getLimits } = await import('./limits')
    const { dailyCapMicros } = getLimits()
    expect(dailyCapMicros).toBe(2_010_000)
    expect(Number.isInteger(dailyCapMicros)).toBe(true)
  })

  it('returns integers only, ready for bigint and integer RPC parameters', async () => {
    vi.stubEnv('OPENAI_DAILY_SPEND_CAP_USD', '19.99')
    const { getLimits } = await import('./limits')
    for (const [name, value] of Object.entries(getLimits())) expect(Number.isInteger(value), name).toBe(true)
  })

  it.each([
    ['RATE_LIMIT_BURST', '0'],
    ['RATE_LIMIT_BURST', '21'],
    ['RATE_LIMIT_ATTEMPTS_PER_DAY', '1001'],
    ['MAX_PROMPT_CHARS', '4001'],
    ['OPENAI_DAILY_SPEND_CAP_USD', '0'],
    ['OPENAI_DAILY_SPEND_CAP_USD', '1000.01'],
    ['OPENAI_DAILY_SPEND_CAP_USD', '2.001'],
    ['OPENAI_ATTEMPT_SPEND_SHARE_PCT', '101'],
    ['HARDENING_MAX_JOBS_PER_USER_PER_HOUR', '21'],
    ['HARDENING_TRAFFIC_MAX_BPS', '9'],
  ])('refuses an out-of-bounds %s=%s by name only', async (name, value) => {
    vi.stubEnv(name, value)
    const { getLimits } = await import('./limits')
    expect(() => getLimits()).toThrow(name)
  })

  it('exports ATTEMPT_MAX_DURATION_S = 30 and ATTEMPT_STALE_SECONDS = 45 (R2-13)', async () => {
    const { ATTEMPT_MAX_DURATION_S, ATTEMPT_STALE_SECONDS } = await import('./limits')
    expect(ATTEMPT_MAX_DURATION_S).toBe(30)
    expect(ATTEMPT_STALE_SECONDS).toBe(ATTEMPT_MAX_DURATION_S + 15)
    expect(ATTEMPT_STALE_SECONDS).toBe(45)
  })
})

describe('isKilledByEnv', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    [' True ', true],
    ['0', false],
    ['false', false],
  ])('PIGGY_KILL_SWITCH=%j gives %s', async (value, expected) => {
    vi.stubEnv('PIGGY_KILL_SWITCH', value)
    const { isKilledByEnv } = await import('./kill-switch')
    expect(isKilledByEnv()).toBe(expected)
  })

  it('is false when unset', async () => {
    const { isKilledByEnv } = await import('./kill-switch')
    expect(isKilledByEnv()).toBe(false)
  })

  it('throws, rather than reading as off, for an unrecognized value', async () => {
    vi.stubEnv('PIGGY_KILL_SWITCH', 'yes')
    const { isKilledByEnv } = await import('./kill-switch')
    expect(() => isKilledByEnv()).toThrow('PIGGY_KILL_SWITCH')
  })
})
