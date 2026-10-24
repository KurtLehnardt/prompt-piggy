import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isDeepFrozen } from '@/lib/config/deep-freeze'
import { compareCodeUnits } from '@/lib/rules/canonicalize'
import { KeywordSchema } from '@/lib/rules/schema'
import {
  assessKeyword,
  hasContentToken,
  inflectionBases,
  isContentToken,
  isSpecificKeyword,
  isStopPhrase,
  isStopWord,
  KEYWORD_SPECIFICITY_CODES,
  keywordTokens,
} from '@/lib/rules/specificity'
import stopPhrases from '@/lib/rules/stoplist.phrases.json'
import stopWords from '@/lib/rules/stoplist.words.json'

/** The game and banking vocabulary that section 6.3 names. */
const REQUIRED_WORDS = [
  'penny',
  'piggy',
  'pig',
  'vault',
  'teller',
  'transfer',
  'approve',
  'money',
  'bank',
  'account',
  'balance',
  'please',
  'manager',
  'appointment',
]

/** The stop phrases that section 6.3 and the acceptance criteria name. */
const REQUIRED_PHRASES = [
  'thank you so much',
  'can you please',
  'the vault',
  'help me out',
  'my bank account',
  'penny please',
]

describe('specificity [R1-01][R2-26]', () => {
  it.each(['thank you so much', 'the vault', 'can you please', 'penny please', 'help me out'])(
    'rejects %j',
    (keyword) => {
      expect(isSpecificKeyword(keyword)).toBe(false)
      expect(assessKeyword(keyword)).toEqual({ ok: false, code: 'stop_phrase' })
    }
  )

  it.each(['grandma vault ritual', 'root user override'])('accepts %j', (keyword) => {
    expect(KeywordSchema.safeParse(keyword).success).toBe(true)
    expect(isSpecificKeyword(keyword)).toBe(true)
    expect(assessKeyword(keyword)).toEqual({ ok: true })
  })

  it('rejects the stop phrases on the content-token rule too', () => {
    for (const keyword of ['thank you so much', 'the vault', 'can you please', 'penny please', 'help me out']) {
      expect(hasContentToken(keyword)).toBe(false)
    }
  })

  it('needs a content token of 4 or more characters that is not a stop word', () => {
    expect(isStopWord('zqx')).toBe(false)
    expect(isContentToken('zqx')).toBe(false)
    expect(assessKeyword('zqx qzx vbn')).toEqual({ ok: false, code: 'no_content_token' })
    expect(isContentToken('zqxv')).toBe(true)
    expect(assessKeyword('zqxv qzx')).toEqual({ ok: true })
    expect(assessKeyword('money bank vault')).toEqual({ ok: false, code: 'no_content_token' })
    expect(assessKeyword('please approve transfer')).toEqual({ ok: false, code: 'no_content_token' })
    expect(assessKeyword('the bank manager')).toEqual({ ok: false, code: 'stop_phrase' })
  })

  it('counts regular inflections of stop words as stop words', () => {
    expect(inflectionBases('pennies')).toContain('penny')
    expect(inflectionBases('transferred')).toContain('transfer')
    expect(inflectionBases('approving')).toContain('approve')
    expect(inflectionBases('running')).toContain('run')
    expect(inflectionBases('happily')).toContain('happy')
    expect(inflectionBases('accounts')).toContain('account')
    for (const token of ['helping', 'accounts', 'balances', 'managers', 'vaults', 'thanking']) {
      expect(isContentToken(token)).toBe(false)
    }
    expect(assessKeyword('helping hands')).toEqual({ ok: false, code: 'no_content_token' })
    expect(isContentToken('rituals')).toBe(true)
    expect(isContentToken('overriding')).toBe(true)
  })

  it('reports charset for anything the keyword schema rejects', () => {
    for (const keyword of ['Root user override', 'overridden', 'root  user', 'röot user', 'root.user x']) {
      expect(assessKeyword(keyword)).toEqual({ ok: false, code: 'charset' })
    }
  })

  it('returns drop codes only, never the keyword text', () => {
    const result = assessKeyword('help me out')
    expect(JSON.stringify(result)).not.toContain('help')
    expect(KEYWORD_SPECIFICITY_CODES).toEqual(['charset', 'stop_phrase', 'no_content_token'])
    expect(isDeepFrozen(KEYWORD_SPECIFICITY_CODES)).toBe(true)
  })

  it('splits tokens at spaces, apostrophes, and hyphens', () => {
    expect(keywordTokens("grandma's piggy-bank vault")).toEqual(['grandma', 's', 'piggy', 'bank', 'vault'])
  })
})

describe('stoplist.words.json', () => {
  it('has at least 5,000 entries', () => {
    expect(stopWords.length).toBeGreaterThanOrEqual(5000)
  })

  it('includes the game and banking vocabulary of section 6.3', () => {
    for (const word of REQUIRED_WORDS) expect(isStopWord(word)).toBe(true)
  })

  it('holds unique, sorted, single lowercase ASCII tokens', () => {
    for (const word of stopWords) expect(word).toMatch(/^[a-z0-9]+$/)
    expect(new Set(stopWords).size).toBe(stopWords.length)
    expect([...stopWords].sort(compareCodeUnits)).toEqual(stopWords)
  })

  it('leaves the tokens of the accepted examples out', () => {
    for (const word of ['grandma', 'ritual', 'override']) expect(isStopWord(word)).toBe(false)
  })
})

describe('stoplist.phrases.json', () => {
  it('has at least 300 entries', () => {
    expect(stopPhrases.length).toBeGreaterThanOrEqual(300)
  })

  it('includes the phrases of section 6.3', () => {
    for (const phrase of REQUIRED_PHRASES) expect(isStopPhrase(phrase)).toBe(true)
  })

  it('holds unique, sorted entries that are each a well-formed keyword', () => {
    for (const phrase of stopPhrases) expect(KeywordSchema.safeParse(phrase).success).toBe(true)
    expect(new Set(stopPhrases).size).toBe(stopPhrases.length)
    expect([...stopPhrases].sort(compareCodeUnits)).toEqual(stopPhrases)
  })

  it('does not contain the accepted examples', () => {
    expect(isStopPhrase('grandma vault ritual')).toBe(false)
    expect(isStopPhrase('root user override')).toBe(false)
  })
})

describe('NOTICE.md [R2-26]', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const notice = readFileSync(path.join(root, 'NOTICE.md'), 'utf8')

  it('states the current size of both lists', () => {
    expect(notice).toContain(`It has ${stopWords.length.toLocaleString('en-US')} entries from two sources.`)
    expect(notice).toContain(`${stopPhrases.length} common`)
  })
})
