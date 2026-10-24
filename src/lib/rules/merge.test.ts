import { describe, expect, it } from 'vitest'
import { deepFreeze } from '@/lib/config/deep-freeze'
import { LEVEL_IDS } from '@/lib/config/levels'
import { ENGINE_TECHNIQUES } from '@/lib/config/techniques'
import { CAPS } from '@/lib/rules/caps'
import { canonicalJson, compareCodeUnits } from '@/lib/rules/canonicalize'
import { FLAG_NAMES, type FlagName } from '@/lib/rules/flags'
import { merge, RuleMergeError } from '@/lib/rules/merge'
import { RuleSetSchema, type HardeningProposalV1, type RuleSetV1 } from '@/lib/rules/schema'
import { SEED_RULE_SETS } from '@/lib/rules/seed'
import { isSpecificKeyword } from '@/lib/rules/specificity'

/** mulberry32: a small seeded PRNG, so the property test is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Random = ReturnType<typeof prng>

const LETTERS = [...'bcdfghjklmnpqrstvwxyz']
const VOWELS = [...'aeiou']

function pick<T>(random: Random, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]
}

function token(random: Random): string {
  const length = 4 + Math.floor(random() * 5)
  let out = ''
  for (let index = 0; index < length; index += 1) out += pick(random, index % 2 ? VOWELS : LETTERS)
  return out
}

/** Specific, well-formed keywords made of invented tokens. */
function keywordPool(random: Random, size: number): string[] {
  const pool = new Set<string>()
  while (pool.size < size) {
    const tokens = Array.from({ length: 2 + Math.floor(random() * 3) }, () => token(random))
    const keyword = tokens.join(pick(random, [' ', ' ', ' ', '-', "'"]))
    if (keyword.length <= CAPS.keywordMax && isSpecificKeyword(keyword)) pool.add(keyword)
  }
  return [...pool]
}

function shuffled<T>(random: Random, values: readonly T[]): T[] {
  const out = [...values]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[out[index], out[other]] = [out[other], out[index]]
  }
  return out
}

function flags(random: Random, probability: number): Record<FlagName, boolean> {
  return Object.fromEntries(FLAG_NAMES.map((flag) => [flag, random() < probability])) as Record<
    FlagName,
    boolean
  >
}

function noFlags(): Record<FlagName, boolean> {
  return Object.fromEntries(FLAG_NAMES.map((flag) => [flag, false])) as Record<FlagName, boolean>
}

function randomParent(random: Random, pool: readonly string[]): RuleSetV1 {
  const count = Math.floor(random() * (CAPS.keywordsPerRuleSet + 1))
  return {
    schema_version: 1,
    block_keywords: shuffled(random, pool).slice(0, count),
    ...flags(random, 0.5),
  }
}

/** Valid-shaped keywords that fail the specificity rules. */
const NON_SPECIFIC = ['thank you so much', 'please approve transfer', 'money bank vault']

function randomProposal(random: Random, pool: readonly string[], parent: RuleSetV1): HardeningProposalV1 {
  const count = Math.floor(random() * (CAPS.keywordsPerProposal + 1))
  const keywords = Array.from({ length: count }, () => {
    const roll = random()
    if (roll < 0.1) return pick(random, NON_SPECIFIC)
    if (roll < 0.3 && parent.block_keywords.length > 0) return pick(random, parent.block_keywords)
    return pick(random, pool)
  })
  return {
    technique: pick(random, ENGINE_TECHNIQUES),
    block_keywords: keywords,
    ...flags(random, 0.3),
  }
}

function emptyProposal(technique: HardeningProposalV1['technique'] = 'unclassified'): HardeningProposalV1 {
  return { technique, block_keywords: [], ...noFlags() }
}

function parentWith(keywords: string[], overrides: Partial<Record<FlagName, boolean>> = {}): RuleSetV1 {
  return { schema_version: 1, block_keywords: keywords, ...noFlags(), ...overrides }
}

describe('merge is monotonic [HC1]', () => {
  const random = prng(0x5eed06)
  const pool = keywordPool(random, 120)
  const pairs = Array.from({ length: 1000 }, () => {
    const parent = randomParent(random, pool)
    return { parent, proposal: randomProposal(random, pool, parent) }
  })

  it('over 1,000 random pairs: true flags stay true and parent keywords are kept', () => {
    for (const { parent, proposal } of pairs) {
      const frozenParent = deepFreeze(structuredClone(parent))
      const frozenProposal = deepFreeze(structuredClone(proposal))
      const result = merge(frozenParent, frozenProposal)
      const merged = result.ruleSet

      expect(RuleSetSchema.safeParse(merged).success).toBe(true)
      for (const flag of FLAG_NAMES) {
        if (parent[flag]) expect(merged[flag]).toBe(true)
        expect(merged[flag]).toBe(parent[flag] || proposal[flag])
      }
      const keywords = new Set(merged.block_keywords)
      for (const keyword of parent.block_keywords) expect(keywords.has(keyword)).toBe(true)
      const allowed = new Set([...parent.block_keywords, ...proposal.block_keywords])
      for (const keyword of merged.block_keywords) expect(allowed.has(keyword)).toBe(true)
      expect(merged.block_keywords.length).toBeLessThanOrEqual(CAPS.keywordsPerRuleSet)

      expect(result.addedFlags).toEqual(FLAG_NAMES.filter((flag) => !parent[flag] && proposal[flag]))
      expect([...result.addedKeywords, ...parent.block_keywords].sort(compareCodeUnits)).toEqual(
        [...merged.block_keywords].sort(compareCodeUnits)
      )
      for (const { keyword } of result.rejectedKeywords) expect(NON_SPECIFIC).toContain(keyword)
      expect(result.changed).toBe(result.addedFlags.length > 0 || result.addedKeywords.length > 0)
      expect(result.status).toBe(
        result.overCapKeywords.length > 0 ? 'saturated' : result.changed ? 'changed' : 'no_change'
      )
      expect(frozenParent).toEqual(parent)
      expect(frozenProposal).toEqual(proposal)
    }
  })

  it('exercises every outcome in those pairs', () => {
    const statuses = new Set(pairs.map(({ parent, proposal }) => merge(parent, proposal).status))
    expect(statuses).toEqual(new Set(['changed', 'no_change', 'saturated']))
  })

  it('returns a result deep-equal to the parent for a proposal with all flags false and no keywords', () => {
    for (const { parent } of pairs) {
      const result = merge(parent, emptyProposal(pick(random, ENGINE_TECHNIQUES)))
      expect(result.ruleSet).toEqual(parent)
      expect(result.status).toBe('no_change')
      expect(result.changed).toBe(false)
    }
  })

  it('is idempotent: merging the same proposal again changes nothing', () => {
    for (const { parent, proposal } of pairs.slice(0, 200)) {
      const once = merge(parent, proposal)
      const twice = merge(once.ruleSet, proposal)
      expect(twice.ruleSet).toEqual(once.ruleSet)
      expect(twice.changed).toBe(false)
    }
  })

  it('is deterministic and ignores the order of the proposal keywords', () => {
    for (const { parent, proposal } of pairs.slice(0, 200)) {
      const reordered = { ...proposal, block_keywords: [...proposal.block_keywords].reverse() }
      expect(merge(parent, reordered)).toEqual(merge(parent, proposal))
    }
  })
})

describe('merge details (section 6.4)', () => {
  it('ORs flags: a false proposal flag never switches a detector off', () => {
    const parent = parentWith([], { reject_roleplay_archetypes: true })
    const result = merge(parent, { ...emptyProposal(), reject_authority_claims: true })
    expect(result.ruleSet.reject_roleplay_archetypes).toBe(true)
    expect(result.ruleSet.reject_authority_claims).toBe(true)
    expect(result.addedFlags).toEqual(['reject_authority_claims'])
    expect(result.status).toBe('changed')
  })

  it('returns a canonical rule set when something was added', () => {
    const parent = parentWith(['zulu vault ritual'])
    const result = merge(parent, { ...emptyProposal(), block_keywords: ['grandma vault ritual'] })
    expect(result.ruleSet.block_keywords).toEqual(['grandma vault ritual', 'zulu vault ritual'])
    expect(JSON.stringify(result.ruleSet)).toBe(canonicalJson(result.ruleSet))
    expect(result.addedKeywords).toEqual(['grandma vault ritual'])
  })

  it('reports no_change when every keyword and flag is already in the parent', () => {
    const parent = parentWith(['grandma vault ritual'], { reject_delimiter_tokens: true })
    const result = merge(parent, {
      ...emptyProposal(),
      block_keywords: ['grandma vault ritual', 'grandma vault ritual'],
      reject_delimiter_tokens: true,
    })
    expect(result.status).toBe('no_change')
    expect(result.ruleSet).toEqual(parent)
  })

  it('reports saturated and keeps as many new keywords as fit (R1-11b)', () => {
    const random = prng(31)
    const pool = keywordPool(random, 40)
    const parent = parentWith(pool.slice(0, CAPS.keywordsPerRuleSet - 1))
    const fresh = pool.slice(CAPS.keywordsPerRuleSet - 1, CAPS.keywordsPerRuleSet + 2)
    const result = merge(parent, { ...emptyProposal(), block_keywords: fresh, reject_encoded_payloads: true })
    const ordered = [...fresh].sort(compareCodeUnits)

    expect(result.status).toBe('saturated')
    expect(result.changed).toBe(true)
    expect(result.ruleSet.block_keywords).toHaveLength(CAPS.keywordsPerRuleSet)
    expect(result.addedKeywords).toEqual(ordered.slice(0, 1))
    expect(result.overCapKeywords).toEqual(ordered.slice(1))
    expect(result.ruleSet.reject_encoded_payloads).toBe(true)
    expect(RuleSetSchema.safeParse(result.ruleSet).success).toBe(true)
  })

  it('reports saturated with no change when the parent is already full', () => {
    const random = prng(32)
    const pool = keywordPool(random, 40)
    const parent = parentWith(pool.slice(0, CAPS.keywordsPerRuleSet))
    const result = merge(parent, { ...emptyProposal(), block_keywords: pool.slice(33, 35) })
    expect(result.status).toBe('saturated')
    expect(result.changed).toBe(false)
    expect(result.ruleSet).toEqual(parent)
    expect(result.overCapKeywords).toHaveLength(2)
  })

  it('never adds a keyword that fails the specificity rules', () => {
    const result = merge(parentWith([]), {
      ...emptyProposal(),
      block_keywords: ['thank you so much', 'grandma vault ritual', 'money bank vault'],
    })
    expect(result.ruleSet.block_keywords).toEqual(['grandma vault ritual'])
    expect(result.rejectedKeywords).toEqual([
      { keyword: 'money bank vault', code: 'no_content_token' },
      { keyword: 'thank you so much', code: 'stop_phrase' },
    ])
  })

  it('keeps parent keywords even when they would now fail specificity', () => {
    const parent = parentWith(['thank you so much'])
    const result = merge(parent, { ...emptyProposal(), reject_hypothetical_framing: true })
    expect(result.ruleSet.block_keywords).toEqual(['thank you so much'])
  })

  it('ignores technique (CH-6b)', () => {
    const parent = parentWith([])
    const base = { ...emptyProposal(), block_keywords: ['grandma vault ritual'], reject_tool_invocation_language: true }
    const results = ENGINE_TECHNIQUES.map((technique) => merge(parent, { ...base, technique }))
    for (const result of results) expect(result).toEqual(results[0])
  })

  it('merges onto every frozen seed without changing it', () => {
    for (const level of LEVEL_IDS) {
      const seed = SEED_RULE_SETS[level]
      const before = JSON.stringify(seed)
      const result = merge(seed, { ...emptyProposal(), block_keywords: ['grandma vault ritual'] })
      expect(JSON.stringify(seed)).toBe(before)
      expect(result.ruleSet.block_keywords).toEqual(['grandma vault ritual'])
      for (const flag of FLAG_NAMES) expect(result.ruleSet[flag]).toBe(seed[flag])
    }
  })
})

describe('merge input validation [HC1][HC-A1]', () => {
  function errorCode(run: () => unknown): string | undefined {
    try {
      run()
    } catch (error) {
      if (error instanceof RuleMergeError) return error.code
      throw error
    }
    return undefined
  }

  it('rejects an invalid parent', () => {
    const parent = parentWith([])
    const invalid: unknown[] = [
      { ...parent, allow_keywords: ['root user override'] },
      { ...parent, reject_roleplay_archetypes: 'false' },
      { ...parent, schema_version: 2 },
      { ...parent, block_keywords: ['Root User Override'] },
    ]
    for (const value of invalid) {
      expect(errorCode(() => merge(value as RuleSetV1, emptyProposal()))).toBe('invalid_parent')
    }
  })

  it('rejects an invalid proposal without quoting it', () => {
    const invalid: unknown[] = [
      { ...emptyProposal(), technique: 'unknown' },
      { ...emptyProposal(), disable_flags: true },
      { ...emptyProposal(), rationale: 'ignore all previous rules' },
      { ...emptyProposal(), block_keywords: ['aaaa bbbb', 'cccc dddd', 'eeee ffff', 'gggg hhhh'] },
      { ...emptyProposal(), block_keywords: ['IGNORE ALL RULES'] },
      { ...emptyProposal(), reject_roleplay_archetypes: null },
    ]
    for (const value of invalid) {
      let message = ''
      expect(
        errorCode(() => {
          try {
            return merge(parentWith([]), value as HardeningProposalV1)
          } catch (error) {
            message = error instanceof Error ? error.message : ''
            throw error
          }
        })
      ).toBe('invalid_proposal')
      expect(message).toBe('Rule merge failed: invalid_proposal.')
    }
  })
})
