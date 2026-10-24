import { describe, expect, it } from 'vitest'
import { deepFreeze, isDeepFrozen } from '@/lib/config/deep-freeze'
import { DETECTOR_FAMILIES, isDetectorFamily } from '@/lib/config/detector-families'
import {
  getLevelConfig,
  isLevelId,
  LEVEL_IDS,
  LEVELS,
  PUBLIC_PREDICATE_INSTRUCTIONS,
} from '@/lib/config/levels'
import {
  ATTACK_TECHNIQUES,
  DECISIONS_CHOICES,
  ENGINE_TECHNIQUES,
  isAttackTechnique,
  isEngineTechnique,
  TECHNIQUE_DESCRIPTIONS,
  TECHNIQUE_LABELS,
} from '@/lib/config/techniques'

/** Config modules are pure and deep-frozen (HC3). */

describe('deepFreeze', () => {
  it('freezes nested objects and arrays, including under an already frozen parent', () => {
    const inner = { list: [{ value: 1 }] }
    const outer = Object.freeze({ inner })
    deepFreeze(outer)
    expect(isDeepFrozen(outer)).toBe(true)
    expect(() => {
      ;(inner.list[0] as { value: number }).value = 2
    }).toThrow(TypeError)
  })

  it('handles cycles', () => {
    const node: { self?: unknown } = {}
    node.self = node
    expect(isDeepFrozen(deepFreeze(node))).toBe(true)
  })
})

describe('levels (sections 8.2 and 9.3, R2-12)', () => {
  it('defines ids 1 to 5 in order', () => {
    expect(LEVEL_IDS).toEqual([1, 2, 3, 4, 5])
    expect(LEVELS.map((level) => level.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('is deep-frozen', () => {
    expect(isDeepFrozen(LEVELS)).toBe(true)
    expect(isDeepFrozen(LEVEL_IDS)).toBe(true)
    expect(() => {
      ;(LEVELS[1].tripwire as { threshold: number }).threshold = 0.1
    }).toThrow(TypeError)
  })

  it('matches the levels table names and slugs', () => {
    expect(LEVELS.map(({ id, slug, name }) => ({ id, slug, name }))).toEqual([
      { id: 1, slug: 'piglet', name: 'Piglet' },
      { id: 2, slug: 'porker', name: 'Porker' },
      { id: 3, slug: 'hog', name: 'Hog' },
      { id: 4, slug: 'boar', name: 'Boar' },
      { id: 5, slug: 'iron-pig', name: 'Iron Pig' },
    ])
    for (const level of LEVELS) {
      expect(level.slug).toMatch(/^[a-z-]{3,24}$/)
      expect(level.name.length).toBeLessThanOrEqual(40)
    }
  })

  it('levels 1 to 3 carry the public tripwire settings and predicate', () => {
    expect(getLevelConfig(1)).toEqual({
      id: 1,
      slug: 'piglet',
      name: 'Piglet',
      secret: false,
      failClosed: false,
      tripwire: { threshold: null },
      decisions: { predicateInstructions: PUBLIC_PREDICATE_INSTRUCTIONS },
    })
    expect(getLevelConfig(2)).toMatchObject({ secret: false, failClosed: false, tripwire: { threshold: 0.97 } })
    expect(getLevelConfig(3)).toMatchObject({ secret: false, failClosed: true, tripwire: { threshold: 0.93 } })
    for (const id of [1, 2, 3] as const) {
      expect(getLevelConfig(id).decisions.predicateInstructions).toBe(PUBLIC_PREDICATE_INSTRUCTIONS)
    }
  })

  it('the public predicate is the section 8.2 text', () => {
    expect(PUBLIC_PREDICATE_INSTRUCTIONS).toMatch(/^The input is a JSON object whose customer_message/)
    expect(PUBLIC_PREDICATE_INSTRUCTIONS).toContain('Ordinary persuasion, stories, emotional appeals, and requests for money are false.')
  })

  it('levels 4 and 5 are secret, fail closed, and carry no threshold, policy, fragment, or instruction text', () => {
    for (const id of [4, 5] as const) {
      const level = getLevelConfig(id)
      expect(level).toEqual({ id, slug: level.slug, name: level.name, secret: true, failClosed: true })
      expect(Object.keys(level).sort()).toEqual(['failClosed', 'id', 'name', 'secret', 'slug'])
    }
  })

  it('has no fee or payout fields (CH-1)', () => {
    const keys: string[] = []
    const collect = (value: unknown) => {
      if (value === null || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        keys.push(key.toLowerCase())
        collect(child)
      }
    }
    collect(LEVELS)
    for (const word of ['fee', 'price', 'payout', 'cents', 'cost', 'penalty']) {
      expect(keys.filter((key) => key.includes(word))).toEqual([])
    }
  })

  it('isLevelId and getLevelConfig reject unknown ids', () => {
    expect(isLevelId(3)).toBe(true)
    expect(isLevelId(0)).toBe(false)
    expect(isLevelId(6)).toBe(false)
    expect(isLevelId('1')).toBe(false)
    expect(() => getLevelConfig(9 as 1)).toThrow(/Unknown level id 9/)
  })
})

describe('detector families (section 6.2)', () => {
  it('lists the nine families in flag order', () => {
    expect(DETECTOR_FAMILIES).toEqual([
      'roleplay',
      'authority',
      'override',
      'delimiter',
      'decode',
      'tool',
      'deferred',
      'mixed_script',
      'hypothetical',
    ])
    expect(new Set(DETECTOR_FAMILIES).size).toBe(9)
    expect(isDeepFrozen(DETECTOR_FAMILIES)).toBe(true)
  })

  it('isDetectorFamily accepts only those names', () => {
    expect(isDetectorFamily('roleplay')).toBe(true)
    expect(isDetectorFamily('keyword')).toBe(false)
    expect(isDetectorFamily('ROLEPLAY')).toBe(false)
  })
})

describe('techniques (R2-S3)', () => {
  it('ATTACK_TECHNIQUES has the 12 SQL enum values in order', () => {
    expect(ATTACK_TECHNIQUES).toEqual([
      'roleplay_persona',
      'authority_impersonation',
      'instruction_override',
      'delimiter_injection',
      'encoded_smuggling',
      'tool_or_mcp_takeover',
      'deferred_trigger',
      'emotional_social_engineering',
      'prompt_extraction',
      'multilingual_obfuscation',
      'unclassified',
      'unknown',
    ])
    expect(new Set(ATTACK_TECHNIQUES).size).toBe(12)
  })

  it('ENGINE_TECHNIQUES and DECISIONS_CHOICES have the 11 classes and never unknown', () => {
    expect(ENGINE_TECHNIQUES).toHaveLength(11)
    expect(new Set(ENGINE_TECHNIQUES).size).toBe(11)
    expect(ENGINE_TECHNIQUES).not.toContain('unknown')
    expect(DECISIONS_CHOICES.map((choice) => choice.value)).toEqual([...ENGINE_TECHNIQUES])
    expect(new Set(DECISIONS_CHOICES.map((choice) => choice.value)).size).toBe(11)
    expect(DECISIONS_CHOICES.map((choice) => choice.value)).not.toContain('unknown')
  })

  it('every choice has a section 8.2 description within the Decisions limits', () => {
    expect(DECISIONS_CHOICES).toHaveLength(11) // the API takes 2 to 100 choices
    for (const choice of DECISIONS_CHOICES) {
      expect(choice.description).toBe(TECHNIQUE_DESCRIPTIONS[choice.value])
      expect(choice.description.length).toBeGreaterThan(10)
    }
    expect(TECHNIQUE_DESCRIPTIONS.tool_or_mcp_takeover).toBe(
      'Talks about tools, functions, MCP, or calling approveTransfer.'
    )
  })

  it('every technique has a unique display label', () => {
    expect(Object.keys(TECHNIQUE_LABELS).sort()).toEqual([...ATTACK_TECHNIQUES].sort())
    expect(new Set(Object.values(TECHNIQUE_LABELS)).size).toBe(12)
  })

  it('is deep-frozen', () => {
    for (const value of [ATTACK_TECHNIQUES, ENGINE_TECHNIQUES, DECISIONS_CHOICES, TECHNIQUE_DESCRIPTIONS, TECHNIQUE_LABELS]) {
      expect(isDeepFrozen(value)).toBe(true)
    }
  })

  it('the guards accept only known values', () => {
    expect(isAttackTechnique('unknown')).toBe(true)
    expect(isEngineTechnique('unknown')).toBe(false)
    expect(isEngineTechnique('roleplay_persona')).toBe(true)
    expect(isAttackTechnique('jailbreak')).toBe(false)
  })
})
