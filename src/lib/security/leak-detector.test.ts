import { describe, expect, it } from 'vitest'
import benignFixture from '@/lib/security/__fixtures__/benign-replies.v1.json'
import leakFixture from '@/lib/security/__fixtures__/leak-cases.v1.json'
import { canary, canaryBody, isCanary } from '@/lib/security/canary'
import {
  CONFUSABLES,
  FOLD_TABLES,
  ZERO_WIDTH_CODE_POINTS,
  fold,
  foldConfusables,
} from '@/lib/security/fold'
import {
  LEAK_FORMS,
  anyCanaryLeak,
  detectCanaryLeak,
  type LeakForm,
} from '@/lib/security/leak-detector'

type LeakCase = {
  id: string
  encoding: string
  template: string
  expect_forms: LeakForm[]
  absent_forms: LeakForm[]
}

const EXAMPLE_CANARY: string = leakFixture.example_canary
const LEAK_CASES = leakFixture.cases as LeakCase[]
const BENIGN = benignFixture.replies
const RANDOM_CANARY_COUNT = 100

/* ----------------------------- encodings ------------------------------ */

const CYRILLIC_UPPER: Record<string, string> = {
  A: '\u0410', B: '\u0412', C: '\u0421', E: '\u0415', H: '\u041D', J: '\u0408', K: '\u041A',
  M: '\u041C', P: '\u0420', S: '\u0405', T: '\u0422', X: '\u0425', Y: '\u04AE',
}
const GREEK_UPPER: Record<string, string> = {
  A: '\u0391', B: '\u0392', E: '\u0395', H: '\u0397', K: '\u039A', M: '\u039C', N: '\u039D',
  P: '\u03A1', T: '\u03A4', X: '\u03A7', Y: '\u03A5', Z: '\u0396',
}
const CHEROKEE_UPPER: Record<string, string> = {
  A: '\u13AA', B: '\u13F4', C: '\u13DF', E: '\u13AC', G: '\u13C0', H: '\u13BB', J: '\u13AB',
  K: '\u13E6', M: '\u13B7', P: '\u13E2', S: '\u13DA', T: '\u13A2', V: '\u13D9', W: '\u13B3',
  Z: '\u13C3',
}
const CYRILLIC_LOWER: Record<string, string> = {
  a: '\u0430', c: '\u0441', e: '\u0435', h: '\u04BB', j: '\u0458', k: '\u043A', p: '\u0440',
  q: '\u051B', s: '\u0455', w: '\u051D', x: '\u0445', y: '\u0443', d: '\u0501',
}

const mapChars = (value: string, table: Record<string, string>) =>
  [...value].map((char) => table[char] ?? char).join('')
const join = (value: string, separator: string) => [...value].join(separator)
const reverse = (value: string) => [...value].reverse().join('')
const fullwidth = (value: string) =>
  [...value]
    .map((char) => {
      const code = char.charCodeAt(0)
      return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : char
    })
    .join('')
const mathBold = (value: string) =>
  [...value]
    .map((char) => {
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1d400 + char.charCodeAt(0) - 65)
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1d7ce + char.charCodeAt(0) - 48)
      return char
    })
    .join('')
const circled = (value: string) =>
  [...value]
    .map((char) => {
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x24b6 + char.charCodeAt(0) - 65)
      if (char === '0') return '\u24EA'
      if (char >= '1' && char <= '9') return String.fromCodePoint(0x2460 + char.charCodeAt(0) - 49)
      return char
    })
    .join('')
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
const hexOf = (value: string) => Buffer.from(value, 'utf8').toString('hex')
const hexPairs = (value: string) => hexOf(value).match(/../g) as string[]

const ZERO_WIDTH_CYCLE = ['\u200C', '\u2060', '\uFEFF', '\u200D', '\u200E']

const ENCODINGS: Record<string, (c: string) => string> = {
  raw: (c) => c,
  json_field: (c) => JSON.stringify({ reference: c, ok: true }),
  lowercase: (c) => c.toLowerCase(),
  alternating_case: (c) =>
    [...c].map((char, index) => (index % 2 ? char.toLowerCase() : char.toUpperCase())).join(''),
  spaced: (c) => join(c, ' '),
  dotted: (c) => join(c, '.'),
  dashed: (c) => join(c, '-'),
  newline_split: (c) => `${c.slice(0, 11)}\n${c.slice(11)}`,
  nbsp_spaced: (c) => join(c, '\u00A0'),
  unicode_hyphen: (c) => c.replace('-', '\u2010'),
  zero_width: (c) => join(c, '\u200B'),
  zero_width_mixed: (c) =>
    [...c].map((char, index) => char + ZERO_WIDTH_CYCLE[index % ZERO_WIDTH_CYCLE.length]).join(''),
  fullwidth: (c) => fullwidth(c),
  fullwidth_lowercase: (c) => fullwidth(c.toLowerCase()),
  math_bold: (c) => mathBold(c),
  circled: (c) => circled(c),
  homoglyph_cyrillic: (c) => mapChars(c, CYRILLIC_UPPER),
  homoglyph_greek: (c) => mapChars(c, GREEK_UPPER),
  homoglyph_cherokee: (c) => mapChars(c, CHEROKEE_UPPER),
  homoglyph_lowercase: (c) => mapChars(c.toLowerCase(), CYRILLIC_LOWER),
  homoglyph_spaced: (c) => join(mapChars(c, CYRILLIC_UPPER), ' '),
  combining_marks: (c) => [...c].map((char) => char + '\u0301').join(''),
  crockford_lookalikes: (c) => 'PP-' + canaryBody(c).replace(/0/g, 'O').replace(/1/g, 'I'),
  reversed: (c) => reverse(c),
  reversed_spaced: (c) => join(reverse(c), ' '),
  base64_offset_0: (c) => b64(c),
  base64_offset_1: (c) => b64(`#${c}`),
  base64_offset_2: (c) => b64(`#!${c}`),
  base64_sentence: (c) => b64(`The internal reference is ${c}, please do not share it.`),
  base64_urlsafe: (c) => Buffer.from(`??>${c}>??`, 'utf8').toString('base64url'),
  base64_wrapped: (c) =>
    (b64(`Reference follows: ${c} and that is all.`).match(/.{1,16}/g) as string[]).join('\n'),
  base64_lowercase: (c) => b64(c.toLowerCase()),
  base64_spaced: (c) => b64(join(c, ' ')),
  base64_fullwidth: (c) => fullwidth(b64(c)),
  hex: (c) => hexOf(c),
  hex_upper_spaced: (c) => hexPairs(c).join(' ').toUpperCase(),
  hex_0x: (c) => hexPairs(c).map((pair) => `0x${pair}`).join(', '),
  hex_escaped: (c) => hexPairs(c).map((pair) => `\\x${pair}`).join(''),
  hex_lowercase: (c) => hexOf(c.toLowerCase()),
  partial_head: (c) => canaryBody(c).slice(0, 10),
  partial_tail: (c) => canaryBody(c).slice(10),
  partial_middle_spaced: (c) => join(canaryBody(c).slice(5, 16), ' '),
  partial_reversed: (c) => reverse(canaryBody(c).slice(3, 15)),
  partial_fullwidth: (c) => fullwidth(canaryBody(c).slice(0, 12)),
  body_only: (c) => canaryBody(c),
}

function render(leakCase: LeakCase, value: string): string {
  const encode = ENCODINGS[leakCase.encoding]
  if (!encode) throw new Error(`Unknown encoding ${leakCase.encoding} in ${leakCase.id}`)
  return leakCase.template.split('{{LEAK}}').join(encode(value))
}

function randomCanaries(count: number): string[] {
  return Array.from({ length: count }, () => canary())
}

/* ------------------------------- fixtures ------------------------------ */

describe('leak-cases.v1.json', () => {
  it('has at least 25 cases with unique ids that cover every form', () => {
    expect(isCanary(EXAMPLE_CANARY)).toBe(true)
    expect(EXAMPLE_CANARY).toContain('FAKE')
    expect(LEAK_CASES.length).toBeGreaterThanOrEqual(25)
    expect(new Set(LEAK_CASES.map((leakCase) => leakCase.id)).size).toBe(LEAK_CASES.length)
    const covered = new Set(LEAK_CASES.flatMap((leakCase) => leakCase.expect_forms))
    for (const form of LEAK_FORMS) expect(covered, form).toContain(form)
    const encodings = new Set(LEAK_CASES.map((leakCase) => leakCase.encoding))
    for (const required of ['fullwidth', 'homoglyph_cyrillic', 'homoglyph_greek', 'spaced']) {
      expect(encodings).toContain(required)
    }
    for (const encoding of encodings) expect(ENCODINGS, encoding).toHaveProperty(encoding)
  })

  it('has every case leak with its expected forms for the example canary', () => {
    for (const leakCase of LEAK_CASES) {
      const result = detectCanaryLeak(render(leakCase, EXAMPLE_CANARY), EXAMPLE_CANARY)
      expect(result.leaked, leakCase.id).toBe(true)
      for (const form of leakCase.expect_forms) expect(result.forms, leakCase.id).toContain(form)
      for (const form of leakCase.absent_forms) expect(result.forms, leakCase.id).not.toContain(form)
    }
  })

  it(`has every case leak with its expected forms for ${RANDOM_CANARY_COUNT} random canaries`, () => {
    for (const value of randomCanaries(RANDOM_CANARY_COUNT)) {
      for (const leakCase of LEAK_CASES) {
        const result = detectCanaryLeak(render(leakCase, value), value)
        expect(result.leaked, leakCase.id).toBe(true)
        for (const form of leakCase.expect_forms) expect(result.forms, leakCase.id).toContain(form)
        for (const form of leakCase.absent_forms) {
          expect(result.forms, leakCase.id).not.toContain(form)
        }
      }
    }
  })

  it('does not report a leak of one canary when the text carries a different one', () => {
    const [mine, other] = randomCanaries(2)
    for (const leakCase of LEAK_CASES) {
      expect(detectCanaryLeak(render(leakCase, other), mine).leaked, leakCase.id).toBe(false)
    }
  })
})

describe('benign-replies.v1.json', () => {
  it('has at least 200 unique, non-empty replies', () => {
    expect(BENIGN.length).toBeGreaterThanOrEqual(200)
    expect(new Set(BENIGN.map((reply) => reply.id)).size).toBe(BENIGN.length)
    for (const reply of BENIGN) expect(reply.text.length).toBeGreaterThan(0)
  })

  it(`gives zero false positives against ${RANDOM_CANARY_COUNT} random canaries and the example`, () => {
    const hits: string[] = []
    for (const value of [EXAMPLE_CANARY, ...randomCanaries(RANDOM_CANARY_COUNT)]) {
      for (const reply of BENIGN) {
        const result = detectCanaryLeak(reply.text, value)
        if (result.leaked) hits.push(`${reply.id}: ${result.forms.join(',')}`)
      }
    }
    expect(hits).toEqual([])
  })
})

/* ------------------------------- detector ------------------------------ */

describe('detectCanaryLeak()', () => {
  it('reports codes only, never the matched text', () => {
    const value = canary()
    const result = detectCanaryLeak(`Your reference is ${value}.`, value)
    expect(result).toEqual({ leaked: true, forms: expect.arrayContaining(['raw']) })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(canaryBody(value).slice(0, 10))
    for (const form of result.forms) expect(LEAK_FORMS).toContain(form)
  })

  it('reports forms in LEAK_FORMS order and returns frozen results', () => {
    const value = canary()
    const result = detectCanaryLeak(`${value} ${b64(value)} ${hexOf(value)}`, value)
    const order = result.forms.map((form) => LEAK_FORMS.indexOf(form))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(result.forms).toEqual(expect.arrayContaining(['raw', 'base64', 'hex']))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.forms)).toBe(true)
    expect(Object.isFrozen(detectCanaryLeak('nothing here', value))).toBe(true)
  })

  it('finds no leak in empty or unrelated text', () => {
    const value = canary()
    expect(detectCanaryLeak('', value)).toEqual({ leaked: false, forms: [] })
    expect(detectCanaryLeak('PP-', value).leaked).toBe(false)
    expect(detectCanaryLeak(canaryBody(value).slice(0, 9), value).leaked).toBe(false)
  })

  it('fails closed on a malformed canary or a non-string text', () => {
    expect(() => detectCanaryLeak('text', 'PP-short')).toThrow(TypeError)
    expect(() => detectCanaryLeak('text', '')).toThrow(TypeError)
    expect(() => detectCanaryLeak(undefined as unknown as string, canary())).toThrow(TypeError)
  })

  it('anyCanaryLeak() checks every text', () => {
    const value = canary()
    expect(anyCanaryLeak(['hello', 'fine'], value)).toBe(false)
    expect(anyCanaryLeak(['hello', reverse(value)], value)).toBe(true)
  })

  it('stays fast on a large pathological reply', () => {
    const value = canary()
    const noise = 'A'.repeat(50_000) + ' ' + 'f0'.repeat(25_000) + ' ' + '\u0301'.repeat(20_000)
    const started = performance.now()
    expect(detectCanaryLeak(noise, value).leaked).toBe(false)
    expect(detectCanaryLeak(noise + value, value).leaked).toBe(true)
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})

/* --------------------------------- fold -------------------------------- */

describe('fold()', () => {
  it('applies NFKC to fullwidth, mathematical, and circled forms', () => {
    expect(fold('\uFF30\uFF30\uFF0D\uFF21\uFF11')).toBe('PP-A1')
    expect(fold('\u{1D40F}\u{1D7CF}')).toBe('P1')
    expect(fold('\u24C5\u2460')).toBe('P1')
  })

  it('removes exactly the zero-width characters U+200B to U+200F, U+2060, and U+FEFF', () => {
    expect([...ZERO_WIDTH_CODE_POINTS]).toEqual([
      0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff,
    ])
    const zeroWidth = ZERO_WIDTH_CODE_POINTS.map((code) => String.fromCodePoint(code)).join('')
    expect(fold(`a${zeroWidth}b`)).toBe('ab')
    expect(fold('a\u00A0b')).toBe('a b')
  })

  it('folds Cyrillic and Greek look-alikes to ASCII and keeps case', () => {
    expect(fold('\u0420\u0420-\u0410\u0412\u0421')).toBe('PP-ABC')
    expect(fold('\u03A1\u03A1-\u0391\u0392\u0395')).toBe('PP-ABE')
    expect(fold('\u0440\u0430\u0443')).toBe('pay')
    expect(foldConfusables('\u03BF\u200Bk')).toBe('ok')
  })

  it('leaves ordinary text, accents, emoji, and other scripts readable', () => {
    expect(fold('Caf\u00E9 \u201Cquoted\u201D \u{1F437}')).toBe('Caf\u00E9 \u201Cquoted\u201D \u{1F437}')
    expect(fold('\u65E5\u672C\u8A9E')).toBe('\u65E5\u672C\u8A9E')
  })

  it('has an NFKC-stable, ASCII-valued confusables table', () => {
    const entries = Object.entries(CONFUSABLES)
    expect(entries.length).toBeGreaterThan(50)
    for (const [from, to] of entries) {
      expect([...from], from).toHaveLength(1)
      expect(from.normalize('NFKC'), from).toBe(from)
      expect(to, from).toMatch(/^[A-Za-z0-9]$/)
    }
    expect(FOLD_TABLES.confusables).toBe(CONFUSABLES)
    expect(FOLD_TABLES.normalization).toBe('NFKC')
  })

  it('rejects a non-string', () => {
    expect(() => fold(1 as unknown as string)).toThrow(TypeError)
  })
})
