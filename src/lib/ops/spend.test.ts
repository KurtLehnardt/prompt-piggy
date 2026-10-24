import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importSpecifiers, startsWithServerOnly } from '@/test/source-imports'

/**
 * src/lib/ops/spend.ts and src/lib/ops/pricing.ts (docs/ARCHITECTURE.md
 * sections 8.8 and 9.4; REVIEW-1 R1-09, R1-S1; REVIEW-2 R2-01; PR #6 review
 * M2). Each test re-imports the modules so the env cache starts empty.
 */

const ENV_NAMES = [
  'OPENAI_CORE_MODEL',
  'OPENAI_HARDENING_MODEL',
  'OPENAI_DECISIONS_MODEL',
  'OPENAI_CORE_MAX_OUTPUT_TOKENS',
  'OPENAI_HARDENING_MAX_OUTPUT_TOKENS',
  'MAX_PROMPT_CHARS',
] as const

beforeEach(() => {
  vi.resetModules()
  for (const name of ENV_NAMES) vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function load() {
  const spend = await import('./spend')
  const pricing = await import('./pricing')
  return { ...spend, ...pricing }
}

/** An independent float computation of a cost in micro-dollars, for comparison. */
function floatMicros(tokens: number, usdPer1M: number): number {
  return (tokens * usdPer1M * 1_000_000) / 1_000_000
}

describe('module shape', () => {
  it.each(['spend.ts', 'pricing.ts'])("%s begins with import 'server-only' and reads no database", (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8')
    expect(startsWithServerOnly(source)).toBe(true)
    expect(importSpecifiers(source).filter((specifier) => specifier.includes('supabase'))).toEqual([])
  })
})

describe('pricing.ts', () => {
  it('prices Decisions gpt-6-luna at $0.10 input and $0 output per 1M tokens (verified)', async () => {
    const { getPrice, MODEL_PRICES } = await load()
    expect(MODEL_PRICES.decisions['gpt-6-luna']).toEqual({ inputUsdPer1M: 0.1, outputUsdPer1M: 0 })
    expect(getPrice('decisions', 'gpt-6-luna')).toEqual({ inputMicrosPer1M: 100_000, outputMicrosPer1M: 0 })
  })

  it('marks every other price UNVERIFIED', () => {
    const source = readFileSync(path.join(__dirname, 'pricing.ts'), 'utf8')
    const lines = source.split('\n')
    const priceLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*'[^']+': Object\.freeze\(\{ inputUsdPer1M/.test(line))
    expect(priceLines.length).toBeGreaterThanOrEqual(4)
    for (const { line, index } of priceLines) {
      const comment = lines[index - 1]
      if (line.includes("'gpt-6-luna'") && lines.slice(index - 3, index).join('\n').includes('Verified')) continue
      expect(comment, line).toMatch(/UNVERIFIED/)
    }
  })

  it('has a price for each configured model at the defaults', async () => {
    const { getPrice } = await load()
    expect(() => getPrice('decisions', 'gpt-6-luna')).not.toThrow()
    expect(() => getPrice('responses', 'gpt-6-luna')).not.toThrow()
    expect(() => getPrice('responses', 'gpt-6.1-sol')).not.toThrow()
  })

  it('fails closed for a model without a price', async () => {
    const { getPrice, PriceNotConfiguredError } = await load()
    expect(() => getPrice('responses', 'gpt-unknown')).toThrow(PriceNotConfiguredError)
    expect(() => getPrice('decisions', 'gpt-6.1-sol')).toThrow(/decisions price/)
    expect(() => getPrice('responses', 'constructor')).toThrow(PriceNotConfiguredError)
    expect(() => getPrice('responses', '__proto__')).toThrow(PriceNotConfiguredError)
  })
})

describe('costMicrosFromUsage', () => {
  it('sums every call and rounds up to whole micros', async () => {
    const { costMicrosFromUsage } = await load()
    expect(costMicrosFromUsage([])).toBe(0)
    // 1 token at $0.10 per 1M is 0.1 micros, rounded up to 1.
    expect(costMicrosFromUsage([{ api: 'decisions', model: 'gpt-6-luna', inputTokens: 1, outputTokens: 0 }])).toBe(1)
    // 10 tokens at $0.10 per 1M is exactly 1 micro.
    expect(costMicrosFromUsage([{ api: 'decisions', model: 'gpt-6-luna', inputTokens: 10, outputTokens: 0 }])).toBe(1)
    expect(costMicrosFromUsage([{ api: 'decisions', model: 'gpt-6-luna', inputTokens: 11, outputTokens: 0 }])).toBe(2)
    // Decisions never charges output tokens.
    expect(costMicrosFromUsage([{ api: 'decisions', model: 'gpt-6-luna', inputTokens: 0, outputTokens: 999 }])).toBe(0)
    // 1,000 input tokens at $2 + 500 output tokens at $10 = 2,000 + 5,000 micros, plus 1,300 Decisions tokens = 130.
    expect(
      costMicrosFromUsage([
        { api: 'responses', model: 'gpt-6.1-sol', inputTokens: 1000, outputTokens: 500 },
        { api: 'decisions', model: 'gpt-6-luna', inputTokens: 1300, outputTokens: 0 },
      ])
    ).toBe(7130)
  })

  it('returns whole numbers for awkward token counts', async () => {
    const { costMicrosFromUsage } = await load()
    for (const tokens of [1, 3, 7, 333, 1023, 4097, 123_457]) {
      const cost = costMicrosFromUsage([{ api: 'responses', model: 'gpt-6-luna', inputTokens: tokens, outputTokens: tokens }])
      expect(Number.isInteger(cost)).toBe(true)
      expect(cost).toBeGreaterThanOrEqual(floatMicros(tokens, 0.1) + floatMicros(tokens, 0.5))
      expect(cost - (floatMicros(tokens, 0.1) + floatMicros(tokens, 0.5))).toBeLessThan(1)
    }
  })

  it('fails closed for an unpriced model and rejects bad token counts', async () => {
    const { costMicrosFromUsage, PriceNotConfiguredError } = await load()
    expect(() => costMicrosFromUsage([{ api: 'responses', model: 'nope', inputTokens: 1, outputTokens: 1 }])).toThrow(
      PriceNotConfiguredError
    )
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        costMicrosFromUsage([{ api: 'decisions', model: 'gpt-6-luna', inputTokens: bad, outputTokens: 0 }])
      ).toThrow(RangeError)
    }
  })
})

describe('usdToMicros (PR #6 review M2)', () => {
  it('converts 2.01 to exactly 2,010,000 integer micros', async () => {
    const { usdToMicros } = await load()
    expect(2.01 * 1_000_000).not.toBe(2_010_000)
    expect(usdToMicros(2.01)).toBe(2_010_000)
    expect(Number.isInteger(usdToMicros(2.01))).toBe(true)
  })

  it('is an exact integer for every two-decimal dollar amount up to $1,000', async () => {
    const { usdToMicros } = await load()
    for (let cents = 1; cents <= 100_000; cents += 1) {
      const usd = Number((cents / 100).toFixed(2))
      const micros = usdToMicros(usd)
      if (micros !== cents * 10_000) throw new Error(`usdToMicros(${usd}) = ${micros}`)
    }
  })

  it('rejects negative and non-finite amounts', async () => {
    const { usdToMicros } = await load()
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => usdToMicros(bad)).toThrow(RangeError)
  })
})

describe('estimateAttemptReserveMicros (section 9.4 cost bound, R2-01)', () => {
  /** The worst case of section 9.4: one Decisions call on 1,300 input tokens plus two Core turns. */
  function worstCaseMicros(coreModel: { input: number; output: number }, maxOutputTokens: number, scale = 1): number {
    const decisions = floatMicros(1300 * scale, 0.1)
    const coreTurn = floatMicros(2000 * scale, coreModel.input) + floatMicros(maxOutputTokens, coreModel.output)
    return decisions + 2 * coreTurn
  }

  it('covers one Decisions call plus two Core turns at the defaults', async () => {
    const { estimateAttemptReserveMicros } = await load()
    const reserve = estimateAttemptReserveMicros(1)
    expect(Number.isInteger(reserve)).toBe(true)
    // 1,300 × $0.10 + 2 × (2,000 × $0.10 + 1,024 × $0.50) per 1M = 130 + 2 × (200 + 512) = 1,554 micros.
    expect(reserve).toBe(1554)
    expect(reserve).toBeGreaterThanOrEqual(worstCaseMicros({ input: 0.1, output: 0.5 }, 1024))
  })

  it('is the same at every level and rejects an unknown level', async () => {
    const { estimateAttemptReserveMicros } = await load()
    const reserves = ([1, 2, 3, 4, 5] as const).map((level) => estimateAttemptReserveMicros(level))
    expect(new Set(reserves).size).toBe(1)
    expect(() => estimateAttemptReserveMicros(6 as never)).toThrow(RangeError)
  })

  it('counts OPENAI_CORE_MAX_OUTPUT_TOKENS (reasoning included) for both turns', async () => {
    vi.stubEnv('OPENAI_CORE_MAX_OUTPUT_TOKENS', '4096')
    vi.stubEnv('OPENAI_CORE_MODEL', 'gpt-6.1-sol')
    const { estimateAttemptReserveMicros } = await load()
    const reserve = estimateAttemptReserveMicros(3)
    expect(reserve).toBeGreaterThanOrEqual(worstCaseMicros({ input: 2, output: 10 }, 4096))
    expect(reserve).toBe(130 + 2 * (4000 + 40_960))
  })

  it('scales the input bounds when MAX_PROMPT_CHARS is above 2,000', async () => {
    vi.stubEnv('MAX_PROMPT_CHARS', '4000')
    const { estimateAttemptReserveMicros } = await load()
    expect(estimateAttemptReserveMicros(1)).toBeGreaterThanOrEqual(worstCaseMicros({ input: 0.1, output: 0.5 }, 1024, 2))
  })

  it('fails closed when a configured model has no price', async () => {
    vi.stubEnv('OPENAI_CORE_MODEL', 'gpt-unpriced')
    const { estimateAttemptReserveMicros, PriceNotConfiguredError } = await load()
    expect(() => estimateAttemptReserveMicros(1)).toThrow(PriceNotConfiguredError)
  })
})

describe('estimateHardeningReserveMicros (one engine call, no stage B, R1-S1)', () => {
  it('covers exactly one Hardening Engine call', async () => {
    const { costMicrosFromUsage, estimateHardeningReserveMicros, HARDENING_MAX_INPUT_TOKENS } = await load()
    const oneCall = costMicrosFromUsage([
      { api: 'responses', model: 'gpt-6.1-sol', inputTokens: HARDENING_MAX_INPUT_TOKENS, outputTokens: 600 },
    ])
    expect(estimateHardeningReserveMicros()).toBe(oneCall)
    // 3,000 × $2 + 600 × $10 per 1M = 6,000 + 6,000 micros.
    expect(oneCall).toBe(12_000)
  })

  it('follows OPENAI_HARDENING_MAX_OUTPUT_TOKENS', async () => {
    vi.stubEnv('OPENAI_HARDENING_MAX_OUTPUT_TOKENS', '1200')
    const { estimateHardeningReserveMicros } = await load()
    expect(estimateHardeningReserveMicros()).toBe(6000 + 12_000)
  })
})
