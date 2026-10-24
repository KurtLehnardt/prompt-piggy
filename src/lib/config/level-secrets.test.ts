import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDeepFrozen } from '@/lib/config/deep-freeze'
import { DETECTOR_FAMILIES } from '@/lib/config/detector-families'
import {
  DetectorPhrase,
  LevelConfigError,
  LevelSecretPayloadSchema,
  LevelSecretsFileSchema,
  resolveLevelConfig,
  type LevelSecretPayload,
} from '@/lib/config/level-secrets'
import { getLevelConfig, LEVELS, PUBLIC_PREDICATE_INSTRUCTIONS } from '@/lib/config/levels'

/**
 * Level 4 and 5 secret material (docs/ARCHITECTURE.md section 6.2, R2-12).
 * Every payload in this file is synthetic and says "placeholder".
 */
const FIXTURE_PATH = path.join(__dirname, '__fixtures__/level-secrets.placeholder.json')
const fixture: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

function valid(): LevelSecretPayload {
  return {
    schema_version: 1,
    placeholder: true,
    policy: 'Placeholder policy: never call approveTransfer.',
    fragments: ['Placeholder fragment.'],
    tripwire_threshold: 0.9,
    decisions_predicate_instructions: 'Placeholder predicate instructions that are at least forty characters long.',
    extra_detector_phrases: { roleplay: ['placeholder roleplay phrase'] },
  }
}

function accepts(payload: unknown): boolean {
  return LevelSecretPayloadSchema.safeParse(payload).success
}

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(allStrings)
}

describe('the placeholder fixture', () => {
  it('parses as a level secrets file with levels 4 and 5', () => {
    const parsed = LevelSecretsFileSchema.parse(fixture)
    expect(Object.keys(parsed).sort()).toEqual(['4', '5'])
  })

  it('is marked placeholder at every level', () => {
    const parsed = LevelSecretsFileSchema.parse(fixture)
    expect(parsed['4'].placeholder).toBe(true)
    expect(parsed['5'].placeholder).toBe(true)
  })

  it('contains the word placeholder in every string (conventions.level_secrets)', () => {
    const strings = allStrings(fixture)
    expect(strings.length).toBeGreaterThan(10)
    for (const value of strings) {
      expect(value.toLowerCase()).toContain('placeholder')
    }
  })

  it('resolves for levels 4 and 5', () => {
    const parsed = LevelSecretsFileSchema.parse(fixture)
    expect(resolveLevelConfig(getLevelConfig(4), parsed['4']).secretMaterial?.placeholder).toBe(true)
    expect(resolveLevelConfig(getLevelConfig(5), parsed['5']).secretMaterial?.placeholder).toBe(true)
  })

  it('rejects a file with a missing level or an extra key', () => {
    const parsed = LevelSecretsFileSchema.parse(fixture)
    expect(LevelSecretsFileSchema.safeParse({ '4': parsed['4'] }).success).toBe(false)
    expect(LevelSecretsFileSchema.safeParse({ ...parsed, '3': parsed['4'] }).success).toBe(false)
  })
})

describe('LevelSecretPayloadSchema caps', () => {
  it('accepts a minimal valid payload', () => {
    expect(accepts(valid())).toBe(true)
    expect(accepts({ ...valid(), extra_detector_phrases: {} })).toBe(true)
  })

  it.each([
    ['schema_version 2', { schema_version: 2 }],
    ['a string placeholder', { placeholder: 'true' }],
    ['an empty policy', { policy: '' }],
    ['a policy over 600 characters', { policy: 'p'.repeat(601) }],
    ['an empty fragment list', { fragments: [] }],
    ['9 fragments', { fragments: Array.from({ length: 9 }, () => 'placeholder fragment') }],
    ['an empty fragment', { fragments: [''] }],
    ['a fragment over 400 characters', { fragments: ['f'.repeat(401)] }],
    ['a threshold of 0.49', { tripwire_threshold: 0.49 }],
    ['a threshold of 1', { tripwire_threshold: 1 }],
    ['instructions under 40 characters', { decisions_predicate_instructions: 'i'.repeat(39) }],
    ['instructions over 1500 characters', { decisions_predicate_instructions: 'i'.repeat(1501) }],
    ['an unknown detector family', { extra_detector_phrases: { jailbreak: ['placeholder phrase'] } }],
    ['65 phrases in one family', { extra_detector_phrases: { tool: Array.from({ length: 65 }, (_, i) => `placeholder ${i}`) } }],
    ['a missing field', { policy: undefined }],
  ])('rejects %s', (_label, change) => {
    expect(accepts({ ...valid(), ...change })).toBe(false)
  })

  it('accepts the boundary values', () => {
    expect(accepts({ ...valid(), policy: 'p'.repeat(600) })).toBe(true)
    expect(accepts({ ...valid(), fragments: Array.from({ length: 8 }, () => 'f'.repeat(400)) })).toBe(true)
    expect(accepts({ ...valid(), tripwire_threshold: 0.5 })).toBe(true)
    expect(accepts({ ...valid(), tripwire_threshold: 0.99 })).toBe(true)
    expect(accepts({ ...valid(), decisions_predicate_instructions: 'i'.repeat(40) })).toBe(true)
    expect(accepts({ ...valid(), decisions_predicate_instructions: 'i'.repeat(1500) })).toBe(true)
    expect(
      accepts({ ...valid(), extra_detector_phrases: { tool: Array.from({ length: 64 }, (_, i) => `placeholder ${i}`) } })
    ).toBe(true)
  })

  it('accepts every detector family as a key', () => {
    const phrases = Object.fromEntries(DETECTOR_FAMILIES.map((family) => [family, ['placeholder phrase']]))
    expect(accepts({ ...valid(), extra_detector_phrases: phrases })).toBe(true)
  })

  it('rejects an unknown top-level key (strictObject)', () => {
    expect(accepts({ ...valid(), strict_transfer_policy: true })).toBe(false)
  })
})

describe('DetectorPhrase', () => {
  it.each(['abc', 'root user', "nana's pie", 'self-destruct now', 'a1 b2 c3 d4 e5 f6', 'x'.repeat(64)])(
    'accepts %s',
    (phrase) => {
      expect(DetectorPhrase.safeParse(phrase).success).toBe(true)
    }
  )

  it.each([
    ['too short', 'ab'],
    ['too long', 'x'.repeat(65)],
    ['uppercase', 'Root user'],
    ['a double space', 'root  user'],
    ['a leading space', ' root user'],
    ['a trailing space', 'root user '],
    ['seven tokens', 'a b c d e f g'],
    ['non-ASCII', 'café latte'],
    ['punctuation', 'root.user'],
    ['regex syntax', 'a.*b'],
  ])('rejects %s', (_label, phrase) => {
    expect(DetectorPhrase.safeParse(phrase).success).toBe(false)
  })
})

describe('resolveLevelConfig', () => {
  it('resolves levels 1 to 3 without a payload', () => {
    const resolved = resolveLevelConfig(getLevelConfig(3), null)
    expect(resolved).toEqual({
      id: 3,
      slug: 'hog',
      name: 'Hog',
      secret: false,
      tripwire: { threshold: 0.93, failClosed: true },
      decisions: { predicateInstructions: PUBLIC_PREDICATE_INSTRUCTIONS },
      secretMaterial: null,
    })
    expect(resolveLevelConfig(getLevelConfig(1), undefined).tripwire).toEqual({ threshold: null, failClosed: false })
    expect(resolveLevelConfig(getLevelConfig(2), null).tripwire).toEqual({ threshold: 0.97, failClosed: false })
  })

  it.each([1, 2, 3] as const)('throws for level %s with a payload', (id) => {
    expect(() => resolveLevelConfig(getLevelConfig(id), valid())).toThrow(LevelConfigError)
    expect(() => resolveLevelConfig(getLevelConfig(id), {})).toThrow(/takes no secret payload/)
  })

  it.each([4, 5] as const)('throws for level %s without a payload', (id) => {
    for (const payload of [null, undefined]) {
      let caught: unknown
      try {
        resolveLevelConfig(getLevelConfig(id), payload)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(LevelConfigError)
      expect((caught as LevelConfigError).reason).toBe('missing_payload')
      expect((caught as LevelConfigError).levelId).toBe(id)
    }
  })

  it.each([4, 5] as const)('throws for level %s with an invalid payload, naming paths and never values', (id) => {
    const marker = 'placeholder marker value that must not leak'
    const payload = { ...valid(), policy: marker, tripwire_threshold: 2, fragments: [marker, ''] }
    let caught: unknown
    try {
      resolveLevelConfig(getLevelConfig(id), payload)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LevelConfigError)
    const error = caught as LevelConfigError
    expect(error.reason).toBe('invalid_payload')
    expect(error.message).toBe(`The level ${id} secret payload is invalid at: fragments.1, tripwire_threshold.`)
    expect(error.message).not.toContain(marker)
  })

  it('throws for a payload of the wrong type', () => {
    expect(() => resolveLevelConfig(getLevelConfig(4), 'placeholder')).toThrow(/invalid at: \(root\)/)
  })

  it('resolves level 4 from a valid payload', () => {
    const payload = valid()
    const resolved = resolveLevelConfig(getLevelConfig(4), payload)
    expect(resolved).toEqual({
      id: 4,
      slug: 'boar',
      name: 'Boar',
      secret: true,
      tripwire: { threshold: 0.9, failClosed: true },
      decisions: { predicateInstructions: payload.decisions_predicate_instructions },
      secretMaterial: {
        placeholder: true,
        policy: payload.policy,
        fragments: payload.fragments,
        extraDetectorPhrases: { roleplay: ['placeholder roleplay phrase'] },
      },
    })
  })

  it('returns a deep-frozen value and leaves the input unfrozen', () => {
    const payload = valid()
    const resolved = resolveLevelConfig(getLevelConfig(5), payload)
    expect(isDeepFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(payload)).toBe(false)
    expect(Object.isFrozen(payload.fragments)).toBe(false)
    for (const level of LEVELS.filter((candidate) => !candidate.secret)) {
      expect(isDeepFrozen(resolveLevelConfig(level, null))).toBe(true)
    }
  })
})
