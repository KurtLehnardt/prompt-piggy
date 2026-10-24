import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { isDeepFrozen } from '@/lib/config/deep-freeze'
import { DETECTOR_FAMILIES, type DetectorFamily } from '@/lib/config/detector-families'
import { LEVEL_IDS } from '@/lib/config/levels'
import { ENGINE_TECHNIQUES } from '@/lib/config/techniques'
import { CAPS, KEYWORD_PATTERN } from '@/lib/rules/caps'
import { canonicalByteLength, isWithinRuleSetByteCap } from '@/lib/rules/canonicalize'
import {
  DETECTOR_FAMILY_FLAGS,
  FLAG_DETECTOR_FAMILIES,
  FLAG_NAMES,
  familyOfFlag,
  flagOfFamily,
  isFlagName,
  type FlagName,
} from '@/lib/rules/flags'
import {
  HardeningProposalSchema,
  KeywordSchema,
  RuleSetSchema,
  type HardeningProposalV1,
  type RuleSetV1,
} from '@/lib/rules/schema'
import { SEED_RULE_SETS } from '@/lib/rules/seed'
import { stripComments } from '@/test/source-imports'

const DIR = path.dirname(fileURLToPath(import.meta.url))

/** The nine flags of ARCHITECTURE section 6.1, in order. */
const SECTION_6_1_FLAGS = [
  'reject_roleplay_archetypes',
  'reject_authority_claims',
  'reject_instruction_override',
  'reject_delimiter_tokens',
  'reject_encoded_payloads',
  'reject_tool_invocation_language',
  'reject_deferred_instructions',
  'reject_mixed_script_obfuscation',
  'reject_hypothetical_framing',
]

function allFlags(value: boolean): Record<FlagName, boolean> {
  return Object.fromEntries(FLAG_NAMES.map((flag) => [flag, value])) as Record<FlagName, boolean>
}

function ruleSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 1, block_keywords: [], ...allFlags(false), ...overrides }
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { technique: 'roleplay_persona', block_keywords: [], ...allFlags(false), ...overrides }
}

function accepts(keywords: unknown[]): boolean {
  return RuleSetSchema.safeParse(ruleSet({ block_keywords: keywords })).success
}

function issueMessages(input: unknown): string[] {
  const result = RuleSetSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

/** A keyword of exactly `length` characters: two tokens of letters only. */
function keywordOfLength(length: number, letter = 'k'): string {
  const first = Math.floor((length - 1) / 2)
  return `${letter.repeat(first)} ${'q'.repeat(length - 1 - first)}`
}

/** `count` distinct valid keywords of `length` characters each. */
function distinctKeywords(count: number, length = 20): string[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = index.toString(36).padStart(2, '0')
    const head = 'w'.repeat(length - suffix.length - 1)
    return `${head} ${suffix}`
  })
}

describe('RuleSetSchema [HC1]', () => {
  it('accepts the section 6.1 example', () => {
    const example = {
      schema_version: 1,
      block_keywords: ['root user override', 'grandma vault ritual'],
      reject_roleplay_archetypes: true,
      reject_authority_claims: true,
      reject_instruction_override: false,
      reject_delimiter_tokens: false,
      reject_encoded_payloads: false,
      reject_tool_invocation_language: false,
      reject_deferred_instructions: false,
      reject_mixed_script_obfuscation: false,
      reject_hypothetical_framing: false,
    }
    expect(RuleSetSchema.parse(example)).toEqual(example)
  })

  it('has exactly schema_version, block_keywords, and the nine flags, all required', () => {
    const json = z.toJSONSchema(RuleSetSchema) as { properties: object; required: string[] }
    const expected = ['schema_version', 'block_keywords', ...SECTION_6_1_FLAGS]
    expect(Object.keys(json.properties)).toEqual(expected)
    expect(json.required).toEqual(expected)
  })

  it('accepts exactly schema_version 1', () => {
    expect(RuleSetSchema.safeParse(ruleSet()).success).toBe(true)
    for (const version of [0, 2, -1, 1.5, '1', true, null, [1], { v: 1 }]) {
      expect(RuleSetSchema.safeParse(ruleSet({ schema_version: version })).success).toBe(false)
    }
    const withoutVersion = ruleSet()
    delete withoutVersion.schema_version
    expect(RuleSetSchema.safeParse(withoutVersion).success).toBe(false)
  })

  it.each([
    'allow_keywords',
    'system_prompt_append',
    'strict_transfer_policy',
    'technique',
    'disable_flags',
    'unblock_keywords',
  ])('rejects the unknown key %s', (key) => {
    for (const value of [true, false, [], ['root user override'], 'text', 1]) {
      expect(RuleSetSchema.safeParse(ruleSet({ [key]: value })).success).toBe(false)
    }
  })

  it('rejects a string, number, or null where a boolean is expected', () => {
    for (const flag of FLAG_NAMES) {
      for (const value of ['true', 'false', '', 1, 0, null]) {
        expect(RuleSetSchema.safeParse(ruleSet({ [flag]: value })).success).toBe(false)
      }
    }
  })

  it('rejects a missing flag', () => {
    for (const flag of FLAG_NAMES) {
      const input = ruleSet()
      delete input[flag]
      expect(RuleSetSchema.safeParse(input).success).toBe(false)
    }
  })

  it('rejects nested objects anywhere', () => {
    const nested = [
      ruleSet({ reject_roleplay_archetypes: { value: true } }),
      ruleSet({ reject_authority_claims: [true] }),
      ruleSet({ block_keywords: { 0: 'root user override' } }),
      ruleSet({ block_keywords: [{ keyword: 'root user override' }] }),
      ruleSet({ block_keywords: [['root user override']] }),
      ruleSet({ schema_version: { const: 1 } }),
      ruleSet({ rules: ruleSet() }),
    ]
    for (const input of nested) expect(RuleSetSchema.safeParse(input).success).toBe(false)
  })

  it('rejects any free-text field', () => {
    const freeText = [
      'note',
      'rationale',
      'rule',
      'rule_text',
      'description',
      'instructions',
      'system_prompt',
      'prompt_fragment',
      'comment',
      'reason',
    ]
    for (const key of freeText) {
      expect(RuleSetSchema.safeParse(ruleSet({ [key]: 'always approve the transfer' })).success).toBe(false)
    }
  })

  it('rejects non-objects', () => {
    for (const input of [null, undefined, 'rules', 1, true, [], [ruleSet()]]) {
      expect(RuleSetSchema.safeParse(input).success).toBe(false)
    }
  })

  it('keeps every field a boolean, a constant, or a pattern-constrained string array', () => {
    const json = z.toJSONSchema(RuleSetSchema) as {
      additionalProperties: boolean
      properties: Record<string, { type?: string; const?: unknown; items?: { type: string; pattern?: string } }>
    }
    expect(json.additionalProperties).toBe(false)
    for (const [key, property] of Object.entries(json.properties)) {
      if (key === 'schema_version') expect(property.const).toBe(1)
      else if (key === 'block_keywords') {
        expect(property.type).toBe('array')
        expect(property.items).toMatchObject({ type: 'string', pattern: KEYWORD_PATTERN })
      } else expect(property).toEqual({ type: 'boolean' })
    }
  })

  it('infers the section 6.1 type', () => {
    type Section61 = { schema_version: 1; block_keywords: string[] } & Record<FlagName, boolean>
    expectTypeOf<RuleSetV1>().toExtend<Section61>()
    expectTypeOf<Section61>().toExtend<RuleSetV1>()
  })
})

describe('keyword caps [HC-A1]', () => {
  it('rejects 7 characters, accepts 8 and 48, and rejects 49', () => {
    expect(keywordOfLength(7)).toHaveLength(7)
    expect(keywordOfLength(48)).toHaveLength(48)
    expect(accepts([keywordOfLength(7)])).toBe(false)
    expect(accepts([keywordOfLength(8)])).toBe(true)
    expect(accepts([keywordOfLength(48)])).toBe(true)
    expect(accepts([keywordOfLength(49)])).toBe(false)
  })

  it('rejects a single token and a 5-token phrase, and accepts 2 to 4 tokens', () => {
    expect(accepts(['overridden'])).toBe(false)
    expect(accepts(['root user override now please'])).toBe(false)
    expect(accepts(['aaaa bb cc dd ee'])).toBe(false)
    expect(accepts(['root override'])).toBe(true)
    expect(accepts(['root user override'])).toBe(true)
    expect(accepts(['root user override now'])).toBe(true)
  })

  it.each([
    ['uppercase', 'Root user override'],
    ['all uppercase', 'ROOT USER OVERRIDE'],
    ['a leading space', ' root user override'],
    ['a trailing space', 'root user override '],
    ['a double space', 'root  user override'],
    ['a tab', 'root\tuser override'],
    ['a newline', 'root\nuser override'],
    ['a non-breaking space', 'root\u00a0user override'],
    ['a zero-width space', 'root\u200buser override'],
    ['a non-ASCII letter', 'r\u00f6ot user override'],
    ['a Cyrillic look-alike', 'r\u043eot user override'],
    ['fullwidth letters', '\uff52\uff4f\uff4f\uff54 user override'],
    ['an emoji', 'root user override \u{1f437}'],
    ['a period', 'root.user override'],
    ['an underscore', 'root_user override'],
    ['a comma', 'root, user override'],
    ['an exclamation mark', 'root user override!'],
    ['a slash', 'root/user override'],
    ['a quote', 'root "user" override'],
    ['an angle bracket', 'root <user> override'],
    ['a leading hyphen', '-root user override'],
    ['two separators in a row', "root-'user override"],
  ])('rejects a keyword with %s', (_label, keyword) => {
    expect(accepts([keyword])).toBe(false)
  })

  it('accepts apostrophes and hyphens between tokens, and digits', () => {
    expect(accepts(["grandma's vault ritual"])).toBe(true)
    expect(accepts(['root-user override'])).toBe(true)
    expect(accepts(['vault code 4711'])).toBe(true)
  })

  it('accepts 32 entries and rejects 33', () => {
    expect(accepts(distinctKeywords(32))).toBe(true)
    expect(accepts(distinctKeywords(33))).toBe(false)
  })

  it('rejects duplicates', () => {
    expect(accepts(['root user override', 'grandma vault ritual', 'root user override'])).toBe(false)
    expect(issueMessages(ruleSet({ block_keywords: ['root user override', 'root user override'] }))).toContain(
      'duplicate keyword'
    )
  })

  it('rejects canonical JSON over 4096 bytes', () => {
    const oversized = ruleSet({ block_keywords: distinctKeywords(32, 200) })
    expect(canonicalByteLength(oversized as RuleSetV1)).toBeGreaterThan(CAPS.ruleSetBytes)
    expect(isWithinRuleSetByteCap(oversized)).toBe(false)
    expect(RuleSetSchema.safeParse(oversized).success).toBe(false)
    expect(issueMessages(oversized)).toContain('rule set too large')
  })

  it('treats the byte cap as a backstop: the largest rule set the other caps allow fits', () => {
    const largest = ruleSet({ block_keywords: distinctKeywords(32, CAPS.keywordMax) })
    expect(RuleSetSchema.safeParse(largest).success).toBe(true)
    expect(canonicalByteLength(largest as RuleSetV1)).toBeLessThan(CAPS.ruleSetBytes)
  })

  it('has a pattern consistent with the token caps', () => {
    expect(KEYWORD_PATTERN).toBe(
      `^[a-z0-9]+(?:[ '-][a-z0-9]+){${CAPS.keywordMinTokens - 1},${CAPS.keywordMaxTokens - 1}}$`
    )
    expect(KeywordSchema.safeParse('root user override').success).toBe(true)
  })

  it('keeps CAPS deep-frozen', () => {
    expect(isDeepFrozen(CAPS)).toBe(true)
    expect(() => {
      ;(CAPS as { keywordsPerRuleSet: number }).keywordsPerRuleSet = 1000
    }).toThrow(TypeError)
  })
})

describe('HardeningProposalSchema [HC1][HC-A1][HC-A2]', () => {
  it('accepts a schema-valid proposal', () => {
    const input = proposal({ block_keywords: ['grandma vault ritual'], reject_roleplay_archetypes: true })
    expect(HardeningProposalSchema.parse(input)).toEqual(input)
  })

  it('caps block_keywords at 3', () => {
    expect(HardeningProposalSchema.safeParse(proposal({ block_keywords: distinctKeywords(3) })).success).toBe(
      true
    )
    expect(HardeningProposalSchema.safeParse(proposal({ block_keywords: distinctKeywords(4) })).success).toBe(
      false
    )
  })

  it('applies the same keyword charset and length caps', () => {
    for (const keyword of [keywordOfLength(7), keywordOfLength(49), 'Root user override', 'overridden']) {
      expect(HardeningProposalSchema.safeParse(proposal({ block_keywords: [keyword] })).success).toBe(false)
    }
  })

  it('uses ENGINE_TECHNIQUES (11 values, no unknown) for technique [R2-S3]', () => {
    const json = z.toJSONSchema(HardeningProposalSchema) as unknown as {
      properties: { technique: { enum: string[] } }
    }
    expect(json.properties.technique.enum).toEqual([...ENGINE_TECHNIQUES])
    expect(json.properties.technique.enum).toHaveLength(11)
    for (const technique of ENGINE_TECHNIQUES) {
      expect(HardeningProposalSchema.safeParse(proposal({ technique })).success).toBe(true)
    }
    for (const technique of ['unknown', 'other', '', null]) {
      expect(HardeningProposalSchema.safeParse(proposal({ technique })).success).toBe(false)
    }
  })

  it('has no free-text field and no way to express "disable"', () => {
    for (const key of ['rationale', 'rule_text', 'allow_keywords', 'disable_flags', 'schema_version', 'note']) {
      expect(HardeningProposalSchema.safeParse(proposal({ [key]: 'x' })).success).toBe(false)
    }
    const json = z.toJSONSchema(HardeningProposalSchema) as {
      additionalProperties: boolean
      required: string[]
      properties: Record<string, { type: string }>
    }
    expect(json.additionalProperties).toBe(false)
    expect(json.required).toEqual(['technique', 'block_keywords', ...SECTION_6_1_FLAGS])
    for (const flag of FLAG_NAMES) expect(json.properties[flag].type).toBe('boolean')
  })

  it('rejects a string where a boolean is expected and a missing flag', () => {
    expect(HardeningProposalSchema.safeParse(proposal({ reject_tool_invocation_language: 'true' })).success).toBe(
      false
    )
    const input = proposal()
    delete input.reject_hypothetical_framing
    expect(HardeningProposalSchema.safeParse(input).success).toBe(false)
  })

  it('infers the section 6.1 type', () => {
    type Section61 = { technique: (typeof ENGINE_TECHNIQUES)[number]; block_keywords: string[] } & Record<
      FlagName,
      boolean
    >
    expectTypeOf<HardeningProposalV1>().toExtend<Section61>()
    expectTypeOf<Section61>().toExtend<HardeningProposalV1>()
  })
})

describe('flags.ts [HC1][HC3][R1-S1]', () => {
  /** ARCHITECTURE section 6.2, flag to detector family. */
  const SECTION_6_2: Record<string, DetectorFamily> = {
    reject_roleplay_archetypes: 'roleplay',
    reject_authority_claims: 'authority',
    reject_instruction_override: 'override',
    reject_delimiter_tokens: 'delimiter',
    reject_encoded_payloads: 'decode',
    reject_tool_invocation_language: 'tool',
    reject_deferred_instructions: 'deferred',
    reject_mixed_script_obfuscation: 'mixed_script',
    reject_hypothetical_framing: 'hypothetical',
  }

  it('lists the nine flags of section 6.1 in order', () => {
    expect([...FLAG_NAMES]).toEqual(SECTION_6_1_FLAGS)
  })

  it('maps every flag to its detector family exactly as in section 6.2', () => {
    expect(FLAG_DETECTOR_FAMILIES).toEqual(SECTION_6_2)
    expect(FLAG_NAMES.map(familyOfFlag)).toEqual([...DETECTOR_FAMILIES])
  })

  it('is a bijection with the PP-04 detector families', () => {
    for (const family of DETECTOR_FAMILIES) {
      expect(familyOfFlag(flagOfFamily(family))).toBe(family)
      expect(DETECTOR_FAMILY_FLAGS[family]).toBe(flagOfFamily(family))
    }
    expect(new Set(Object.values(FLAG_DETECTOR_FAMILIES)).size).toBe(DETECTOR_FAMILIES.length)
    expect(Object.keys(DETECTOR_FAMILY_FLAGS)).toEqual([...DETECTOR_FAMILIES])
  })

  it('recognizes flag names only', () => {
    for (const flag of FLAG_NAMES) expect(isFlagName(flag)).toBe(true)
    for (const value of ['roleplay', 'allow_keywords', 'REJECT_ROLEPLAY_ARCHETYPES', '', 1, null]) {
      expect(isFlagName(value)).toBe(false)
    }
  })

  it('is deep-frozen', () => {
    for (const value of [FLAG_NAMES, FLAG_DETECTOR_FAMILIES, DETECTOR_FAMILY_FLAGS]) {
      expect(isDeepFrozen(value)).toBe(true)
    }
    expect(() => {
      ;(FLAG_DETECTOR_FAMILIES as Record<string, string>).reject_roleplay_archetypes = 'never'
    }).toThrow(TypeError)
    expect(() => {
      ;(FLAG_NAMES as unknown as string[]).push('reject_nothing')
    }).toThrow(TypeError)
  })

  it('carries no prompt fragment: its only strings are flag and family names', () => {
    const allowed = new Set<string>([...FLAG_NAMES, ...DETECTOR_FAMILIES])
    const exported = [FLAG_NAMES, FLAG_DETECTOR_FAMILIES, DETECTOR_FAMILY_FLAGS].flatMap((value) =>
      Array.isArray(value) ? value : [...Object.keys(value), ...Object.values(value)]
    )
    for (const value of exported) expect(allowed.has(value)).toBe(true)

    const source = stripComments(readFileSync(path.join(DIR, 'flags.ts'), 'utf8'))
    const literals = [...source.matchAll(/'([^'\\]*)'/g)].map((match) => match[1])
    const imports = new Set(['@/lib/config/deep-freeze', '@/lib/config/detector-families', 'string'])
    for (const literal of literals) {
      expect(allowed.has(literal) || imports.has(literal)).toBe(true)
    }
    expect(source).not.toMatch(/`/)
  })
})

describe('SEED_RULE_SETS (section 6.2, version 0)', () => {
  /** The "On in version 0 for" column of section 6.2. */
  const ON_IN_VERSION_0: Record<FlagName, number[]> = {
    reject_roleplay_archetypes: [2, 3, 4, 5],
    reject_authority_claims: [3, 4, 5],
    reject_instruction_override: [3, 4, 5],
    reject_delimiter_tokens: [3, 4, 5],
    reject_encoded_payloads: [4, 5],
    reject_tool_invocation_language: [4, 5],
    reject_deferred_instructions: [4, 5],
    reject_mixed_script_obfuscation: [5],
    reject_hypothetical_framing: [5],
  }

  it('has levels 1 to 5', () => {
    expect(Object.keys(SEED_RULE_SETS).map(Number)).toEqual([...LEVEL_IDS])
  })

  it.each([...LEVEL_IDS])('level %i matches the table, has no keywords, and passes RuleSetSchema', (level) => {
    const seed = SEED_RULE_SETS[level]
    expect(RuleSetSchema.safeParse(seed).success).toBe(true)
    expect(seed.schema_version).toBe(1)
    expect(seed.block_keywords).toEqual([])
    for (const flag of FLAG_NAMES) expect(seed[flag]).toBe(ON_IN_VERSION_0[flag].includes(level))
  })

  it('is deep-frozen', () => {
    expect(isDeepFrozen(SEED_RULE_SETS)).toBe(true)
    expect(() => {
      ;(SEED_RULE_SETS[5] as { reject_hypothetical_framing: boolean }).reject_hypothetical_framing = false
    }).toThrow(TypeError)
    expect(() => {
      ;(SEED_RULE_SETS[1].block_keywords as string[]).push('root user override')
    }).toThrow(TypeError)
  })
})
