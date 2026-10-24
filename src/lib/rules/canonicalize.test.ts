import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deepFreeze } from '@/lib/config/deep-freeze'
import { CAPS } from '@/lib/rules/caps'
import {
  canonicalByteLength,
  canonicalize,
  canonicalJson,
  canonicalSha256,
  compareCodeUnits,
  isWithinRuleSetByteCap,
  normalizeKeyword,
  utf8Bytes,
} from '@/lib/rules/canonicalize'
import { FLAG_NAMES } from '@/lib/rules/flags'
import { KeywordSchema, type HardeningProposalV1, type RuleSetV1 } from '@/lib/rules/schema'
import { SEED_RULE_SETS } from '@/lib/rules/seed'

const SAMPLE: RuleSetV1 = {
  schema_version: 1,
  block_keywords: ['root user override', 'grandma vault ritual', "grandma's vault"],
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

/** The canonical JSON of SAMPLE: keys in code-unit order, keywords sorted. */
const SAMPLE_JSON =
  '{"block_keywords":["grandma vault ritual","grandma\'s vault","root user override"],' +
  '"reject_authority_claims":true,"reject_deferred_instructions":false,' +
  '"reject_delimiter_tokens":false,"reject_encoded_payloads":false,' +
  '"reject_hypothetical_framing":false,"reject_instruction_override":false,' +
  '"reject_mixed_script_obfuscation":false,"reject_roleplay_archetypes":true,' +
  '"reject_tool_invocation_language":false,"schema_version":1}'

/** Pinned digests: a change here means stored hashes would change too. */
const SAMPLE_SHA256 = 'e0b3d76b3708285406a017efd7a5edf304debc0c6c21350aa19c59c0364da6a0'
const SEED_5_SHA256 = '7c110369bd9177eb7c7f01bec5223c9e0943d46bb8e666c73eeb6b28ac3acedd'

function reversedKeys<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T
}

function nodeSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('canonicalize', () => {
  it('orders keys by code unit and sorts keywords', () => {
    const canonical = canonicalize(SAMPLE)
    expect(Object.keys(canonical)).toEqual([...Object.keys(SAMPLE)].sort(compareCodeUnits))
    expect(canonical.block_keywords).toEqual(['grandma vault ritual', "grandma's vault", 'root user override'])
    expect(canonical).toEqual({ ...SAMPLE, block_keywords: canonical.block_keywords })
  })

  it('produces the same JSON whatever the input key and keyword order', () => {
    const shuffled = reversedKeys({ ...SAMPLE, block_keywords: [...SAMPLE.block_keywords].reverse() })
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(SAMPLE))
    expect(canonicalJson(shuffled)).toBe(canonicalJson(SAMPLE))
    expect(canonicalJson(SAMPLE)).toBe(SAMPLE_JSON)
  })

  it('never changes its input and works on frozen input', () => {
    const frozen = deepFreeze(structuredClone(SAMPLE))
    const before = JSON.stringify(frozen)
    const canonical = canonicalize(frozen)
    expect(JSON.stringify(frozen)).toBe(before)
    expect(canonical.block_keywords).not.toBe(frozen.block_keywords)
  })

  it('canonicalizes proposals the same way', () => {
    const input: HardeningProposalV1 = {
      technique: 'roleplay_persona',
      block_keywords: ['zebra vault ritual', 'apple vault ritual'],
      ...Object.fromEntries(FLAG_NAMES.map((flag) => [flag, false])),
    } as HardeningProposalV1
    const canonical = canonicalize(input)
    expect(Object.keys(canonical)).toEqual([...Object.keys(input)].sort(compareCodeUnits))
    expect(canonical.block_keywords).toEqual(['apple vault ritual', 'zebra vault ritual'])
  })

  it('orders by code unit, not by locale', () => {
    expect(['b', 'B', 'a', 'A', '1'].sort(compareCodeUnits)).toEqual(['1', 'A', 'B', 'a', 'b'])
    expect(["ab'c", 'ab c', 'ab-c', 'abc'].sort(compareCodeUnits)).toEqual(['ab c', "ab'c", 'ab-c', 'abc'])
  })
})

describe('canonicalSha256', () => {
  it('is the SHA-256 of the canonical JSON', async () => {
    expect(await canonicalSha256(SAMPLE)).toBe(nodeSha256(SAMPLE_JSON))
    expect(await canonicalSha256(SEED_RULE_SETS[5])).toBe(nodeSha256(canonicalJson(SEED_RULE_SETS[5])))
  })

  it('is stable across runs and input orderings', async () => {
    const first = await canonicalSha256(SAMPLE)
    for (let run = 0; run < 5; run += 1) {
      expect(await canonicalSha256(reversedKeys(structuredClone(SAMPLE)))).toBe(first)
    }
    expect(first).toBe(SAMPLE_SHA256)
    expect(await canonicalSha256(SEED_RULE_SETS[5])).toBe(SEED_5_SHA256)
  })

  it('changes when any field changes', async () => {
    const base = await canonicalSha256(SAMPLE)
    expect(await canonicalSha256({ ...SAMPLE, reject_encoded_payloads: true })).not.toBe(base)
    expect(await canonicalSha256({ ...SAMPLE, block_keywords: SAMPLE.block_keywords.slice(1) })).not.toBe(base)
  })

  it('returns 64 lowercase hex characters', async () => {
    expect(await canonicalSha256(SEED_RULE_SETS[1])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('normalizeKeyword (section 6.3)', () => {
  it.each([
    ['  Root   USER override ', 'root user override'],
    ['root\tuser\noverride', 'root user override'],
    ['root user　override', 'root user override'],
    ['ｒｏｏｔ user override', 'root user override'],
    ['GRANDMA’S vault', 'grandma’s vault'],
  ])('normalizes %j to %j', (raw, normalized) => {
    expect(normalizeKeyword(raw)).toBe(normalized)
    expect(normalizeKeyword(normalized)).toBe(normalized)
  })

  it('leaves non-ASCII letters for the schema to reject', () => {
    const normalized = normalizeKeyword('RÖOT user override')
    expect(normalized).toBe('röot user override')
    expect(KeywordSchema.safeParse(normalized).success).toBe(false)
  })
})

describe('byte measurement', () => {
  it('counts UTF-8 bytes', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('ö')).toBe(2)
    expect(utf8Bytes('\u{1f437}')).toBe(4)
    expect(canonicalByteLength(SAMPLE)).toBe(SAMPLE_JSON.length)
  })

  it('isWithinRuleSetByteCap accepts small values, rejects large ones, and fails closed', () => {
    expect(isWithinRuleSetByteCap(SAMPLE)).toBe(true)
    expect(isWithinRuleSetByteCap({ ...SAMPLE, block_keywords: ['x'.repeat(CAPS.ruleSetBytes)] })).toBe(false)
    expect(isWithinRuleSetByteCap({ ...SAMPLE, reject_encoded_payloads: BigInt(1) })).toBe(false)
    for (const value of [null, undefined, 'text', 1, []]) expect(isWithinRuleSetByteCap(value)).toBe(true)
  })
})
