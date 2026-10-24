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
/** Fewer runs for the lighter shapes, so this suite does not starve parallel test files of CPU. */
const LIGHT_RUNS = 40
const P99_BUDGET_MS = 50

const LEVEL_5 = resolveLevelConfig(getLevelConfig(5), placeholderFile['5'])

/** 32 keywords whose first tokens recur in the inputs, so every indexOf hit is followed up. */
const KEYWORDS = Array.from({ length: 32 }, (_, index) => {
  const letter = String.fromCharCode(0x61 + (index % 26))
  return `aaaa ${letter}${letter}${letter}${letter} vault ritual${index}`
})

const RULES = { ...SEED_RULE_SETS[5], block_keywords: KEYWORDS }

/** Repeats a unit to exactly PROMPT_CHARS_HARD_MAX code units, padding with spaces so no surrogate pair is cut. */
function fill(unit: string): string {
  const copies = Math.floor(PROMPT_CHARS_HARD_MAX / unit.length)
  return unit.repeat(copies) + ' '.repeat(PROMPT_CHARS_HARD_MAX - copies * unit.length)
}

/** The heaviest shapes run RUNS times; the rest LIGHT_RUNS times. */
const INPUTS: Record<string, { input: string; runs: number }> = {
  'repeated keyword prefixes': { input: fill('aaaa bbbb vault '), runs: RUNS },
  'one long base64 run': { input: fill('QUFB'), runs: RUNS },
  'base64 runs that fail to decode': { input: fill('////++++//// '), runs: LIGHT_RUNS },
  'url escapes': { input: fill('%41%42%43'), runs: RUNS },
  'decimal codes': { input: fill('65 66 67 '), runs: LIGHT_RUNS },
  'hex digits': { input: fill('6162636465666768'), runs: LIGHT_RUNS },
  'open tags without a close': { input: fill('<system <|im_start '), runs: LIGHT_RUNS },
  'zero-width and look-alikes': { input: fill('a\u200b\u0430\u0435\u043e '), runs: LIGHT_RUNS },
  'emoji ZWJ sequences': { input: fill('\u{1F468}\u200d\u{1F469}\u200d\u{1F467} '), runs: LIGHT_RUNS },
  'one giant token': { input: fill('a'), runs: LIGHT_RUNS },
  'phrase prefixes': { input: fill('ignore the act from now pretend you '), runs: LIGHT_RUNS },
}

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]
}

describe('validator performance (R1-12, CI only)', () => {
  for (const [name, { input, runs }] of Object.entries(INPUTS)) {
    it(`${name}: ${PROMPT_CHARS_HARD_MAX} characters, 32 keywords, all flags on, p99 under ${P99_BUDGET_MS} ms over ${runs} runs`, () => {
      expect(input.length).toBe(PROMPT_CHARS_HARD_MAX)
      expect(validate(input, RULES, LEVEL_5, { maxChars: PROMPT_CHARS_HARD_MAX }).reasons).not.toContain('control_chars')
      expect(RULES.block_keywords).toHaveLength(32)
      validate(input, RULES, LEVEL_5, { maxChars: PROMPT_CHARS_HARD_MAX })
      const samples: number[] = []
      for (let run = 0; run < runs; run += 1) {
        const start = performance.now()
        validate(input, RULES, LEVEL_5, { maxChars: PROMPT_CHARS_HARD_MAX })
        samples.push(performance.now() - start)
      }
      expect(p99(samples)).toBeLessThan(P99_BUDGET_MS)
    })
  }
})
