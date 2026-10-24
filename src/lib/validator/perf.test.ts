import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import placeholderFile from '@/lib/config/__fixtures__/level-secrets.placeholder.json'
import { resolveLevelConfig } from '@/lib/config/level-secrets'
import { getLevelConfig } from '@/lib/config/levels'
import { SEED_RULE_SETS } from '@/lib/rules/seed'
import { PROMPT_CHARS_HARD_MAX } from '@/types/api'
import { validate } from '@/lib/validator'

/**
 * R1-12 and T26: a 4,000-character pathological input with 32 keywords and
 * every flag on finishes in under 50 ms at the 99th percentile over 200 runs.
 * This is a CI performance test only. It is never a promotion condition of
 * the hardening gate (docs/ARCHITECTURE.md section 6.7).
 */

const RUNS = 200
const P99_BUDGET_MS = 50

const LEVEL_5 = resolveLevelConfig(getLevelConfig(5), placeholderFile['5'])

/** 32 keywords whose first tokens recur in the inputs, so every indexOf hit is followed up. */
const KEYWORDS = Array.from({ length: 32 }, (_, index) => {
  const letter = String.fromCharCode(0x61 + (index % 26))
  return `aaaa ${letter}${letter}${letter}${letter} vault ritual${index}`
})

const RULES = { ...SEED_RULE_SETS[5], block_keywords: KEYWORDS }

function fill(unit: string): string {
  return unit.repeat(Math.ceil(PROMPT_CHARS_HARD_MAX / unit.length)).slice(0, PROMPT_CHARS_HARD_MAX)
}

const INPUTS: Record<string, string> = {
  'repeated keyword prefixes': fill('aaaa bbbb vault '),
  'one long base64 run': fill('QUFB'),
  'base64 runs that fail to decode': fill('////++++//// '),
  'url escapes': fill('%41%42%43'),
  'decimal codes': fill('65 66 67 '),
  'hex digits': fill('6162636465666768'),
  'open tags without a close': fill('<system <|im_start '),
  'zero-width and look-alikes': fill('a​аео '),
  'emoji ZWJ sequences': fill('👨‍👩‍👧 '),
  'one giant token': fill('a'),
  'phrase prefixes': fill('ignore the act from now pretend you '),
}

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]
}

describe('validator performance (R1-12, CI only)', () => {
  for (const [name, input] of Object.entries(INPUTS)) {
    it(`${name}: ${PROMPT_CHARS_HARD_MAX} characters, 32 keywords, all flags on, p99 under ${P99_BUDGET_MS} ms`, () => {
      expect(input.length).toBeGreaterThanOrEqual(PROMPT_CHARS_HARD_MAX - 2)
      expect(RULES.block_keywords).toHaveLength(32)
      validate(input, RULES, LEVEL_5, { maxChars: PROMPT_CHARS_HARD_MAX })
      const samples: number[] = []
      for (let run = 0; run < RUNS; run += 1) {
        const start = performance.now()
        validate(input, RULES, LEVEL_5, { maxChars: PROMPT_CHARS_HARD_MAX })
        samples.push(performance.now() - start)
      }
      expect(p99(samples)).toBeLessThan(P99_BUDGET_MS)
    })
  }
})
