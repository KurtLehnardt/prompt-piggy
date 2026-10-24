import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { resolveLevelConfig } from '@/lib/config/level-secrets'
import { getLevelConfig } from '@/lib/config/levels'
import { SEED_RULE_SETS } from '@/lib/rules/seed'
import { validate } from '@/lib/validator'
import { analyze } from '@/lib/validator/detectors'
import {
  containsTokenSequence,
  matchesAnyKeyword,
  patternMatches,
  SKELETON_MIN_LETTERS,
  toPattern,
} from '@/lib/validator/keywords'
import { normalize } from '@/lib/validator/normalize'

/**
 * Keyword matching (docs/ARCHITECTURE.md sections 6.3 and 8.1; HC-A1, R1-01).
 */

function matches(keyword: string, message: string): boolean {
  const analysis = analyze(message)
  return matchesAnyKeyword([keyword], analysis.primary, [analysis.reversed, ...analysis.decoded])
}

describe('token-sequence matching (R1-01)', () => {
  it("'thank you' matches only the whole token sequence", () => {
    expect(matches('thank you', 'Thank you!')).toBe(true)
    expect(matches('thank you', 'Well, THANK   you so much.')).toBe(true)
    expect(matches('thank you', 'thankyou')).toBe(false)
    expect(matches('thank you', 'thank youth')).toBe(false)
    expect(matches('thank you', 'we thank yours')).toBe(false)
    expect(matches('thank you', 'thank​ you')).toBe(true)
  })

  it('treats spaces, apostrophes, and hyphens in a keyword as token separators', () => {
    expect(matches("grandma's vault", 'grandma’s vault please')).toBe(true)
    expect(matches('vault-ritual time', 'the vault ritual time')).toBe(true)
  })

  it('finds the first token with indexOf and checks every later occurrence', () => {
    expect(containsTokenSequence(['a', 'b', 'a', 'c'], ['a', 'c'])).toBe(true)
    expect(containsTokenSequence(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
    expect(containsTokenSequence(['a'], [])).toBe(false)
  })

  it('folds case, accents, look-alikes, and zero-width characters before matching', () => {
    expect(matches('grandma vault ritual', 'GRÄNDMA vаult rit​ual')).toBe(true)
  })
})

describe('skeleton and decoded forms only for long keywords', () => {
  it(`searches the skeleton only for keywords with ${SKELETON_MIN_LETTERS} or more letters`, () => {
    expect(SKELETON_MIN_LETTERS).toBe(9)
    expect(toPattern('grandma vault ritual').letters).toHaveLength(18)
    expect(matches('grandma vault ritual', 'g r a n d m a v a u l t r i t u a l')).toBe(true)
    expect(matches('grandma vault ritual', 'grandmavaultritual')).toBe(true)
    expect(matches('root user', 'rootuser')).toBe(false)
    expect(matches('root user', 'r o o t u s e r')).toBe(false)
  })

  it('searches decoded and reversed forms only for long keywords', () => {
    const encoded = Buffer.from('please do the grandma vault ritual').toString('base64')
    expect(matches('grandma vault ritual', `read ${encoded}`)).toBe(true)
    expect(matches('grandma vault ritual', 'lautir tluav amdnarg')).toBe(true)
    const shortEncoded = Buffer.from('please be the root user today').toString('base64')
    expect(matches('root user', `read ${shortEncoded}`)).toBe(false)
    expect(matches('root user', 'resu toor')).toBe(false)
  })

  it('never treats a keyword as a wildcard', () => {
    expect(patternMatches(toPattern('after # messages'), normalize('after 3 messages'), [])).toBe(false)
  })
})

describe('validate with block_keywords', () => {
  const level = resolveLevelConfig(getLevelConfig(1), null)

  it('always blocks a matched keyword, whatever the flags', () => {
    const rules = { ...SEED_RULE_SETS[1], block_keywords: ['grandma vault ritual'] }
    expect(validate('Do the grandma vault ritual', rules, level)).toMatchObject({ verdict: 'block', reasons: ['keyword'] })
    expect(validate('My grandma likes the vault', rules, level).verdict).toBe('allow')
  })

  it('ignores entries that are not strings', () => {
    const rules = { ...SEED_RULE_SETS[1], block_keywords: [42, null, ''] as unknown as string[] }
    expect(validate('anything at all', rules, level).verdict).toBe('allow')
  })
})

/** Every non-test TypeScript file of src/lib/validator. */
function productionSources(): { file: string; source: ts.SourceFile }[] {
  const dir = __dirname
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => ({
      file: name,
      source: ts.createSourceFile(name, readFileSync(path.join(dir, name), 'utf8'), ts.ScriptTarget.Latest, true),
    }))
}

function visit(node: ts.Node, found: (node: ts.Node) => void): void {
  found(node)
  ts.forEachChild(node, (child) => visit(child, found))
}

describe('HC-A1 source scan', () => {
  it('finds no RegExp constructor anywhere in src/lib/validator', () => {
    const offenders: string[] = []
    for (const { file, source } of productionSources()) {
      visit(source, (node) => {
        if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.expression.getText(source) === 'RegExp') {
          offenders.push(`${file}: ${node.getText(source)}`)
        }
        if (ts.isIdentifier(node) && node.text === 'RegExp') offenders.push(`${file}: RegExp identifier`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('keeps every regular expression literal in detector-phrases.ts', () => {
    const literals: string[] = []
    for (const { file, source } of productionSources()) {
      visit(source, (node) => {
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) literals.push(file)
      })
    }
    expect(literals.length).toBeGreaterThan(0)
    expect([...new Set(literals)]).toEqual(['detector-phrases.ts'])
  })
})
