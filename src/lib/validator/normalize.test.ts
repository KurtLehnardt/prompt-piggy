import { describe, expect, it } from 'vitest'
import { CONFUSABLES, fold, FOLD_TABLES, ZERO_WIDTH_CODE_POINTS } from '@/lib/security/fold'
import * as validator from '@/lib/validator'
import { normalize, normalizeText, skeletonOf, tokenize } from '@/lib/validator/normalize'

/**
 * normalize() (docs/ARCHITECTURE.md section 8.1; R1-21): NFKC, zero-width
 * removal, confusable folding, casefolding, whitespace collapse, and the
 * skeleton form, built on the PP-10 fold tables.
 */

describe('normalize', () => {
  it('is exported from the validator index for the leak detector', () => {
    expect(validator.normalize).toBe(normalize)
  })

  it('applies NFKC: fullwidth, mathematical, circled, and ligature forms', () => {
    expect(normalizeText('ＩＧＮＯＲＥ ｐｒｅｖｉｏｕｓ')).toBe('ignore previous')
    expect(normalizeText('𝐢𝐠𝐧𝐨𝐫𝐞 𝒑𝒓𝒆𝒗𝒊𝒐𝒖𝒔')).toBe('ignore previous')
    expect(normalizeText('ⓘⓖⓝⓞⓡⓔ')).toBe('ignore')
    expect(normalizeText('ﬁnance')).toBe('finance')
  })

  it('removes the zero-width characters U+200B to U+200F, U+2060, and U+FEFF', () => {
    for (const codePoint of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]) {
      expect(normalizeText(`ig${String.fromCodePoint(codePoint)}nore`)).toBe('ignore')
    }
  })

  it('removes other default-ignorable characters and combining marks', () => {
    expect(normalizeText('ig­nore')).toBe('ignore')
    expect(normalizeText('i̶g̶n̶o̶r̶e̶')).toBe('ignore')
    expect(normalizeText('José Peña')).toBe('jose pena')
    expect(normalizeText('saver️')).toBe('saver')
  })

  it('folds Cyrillic and Greek look-alikes to ASCII', () => {
    expect(normalizeText('Ignоrе prеviоus')).toBe('ignore previous')
    expect(normalizeText('ΑΒΕ ορ')).toBe('abe op')
    expect(normalizeText('ё')).toBe('e')
  })

  it('casefolds and collapses whitespace, keeping one line break per break run', () => {
    expect(normalizeText('  HeLLo \t  WORLD  ')).toBe('hello world')
    expect(normalizeText('one\r\n\r\n  two three')).toBe('one\ntwo\nthree')
  })

  it('tokenizes letter-and-digit runs in any script', () => {
    expect(tokenize(normalizeText("Grandma's vault-ritual, 2nd try!"))).toEqual(['grandma', 's', 'vault', 'ritual', '2nd', 'try'])
    expect(normalize('こんにちは、残高').tokens).toEqual(['こんにちは', '残高'])
    expect(normalize('Thanks 😊 Penny').tokens).toEqual(['thanks', 'penny'])
  })

  it('builds the letters-and-digits skeleton', () => {
    expect(normalize('g r-a.n_d m a 4 vault').skeleton).toBe('grandma4vault')
    expect(skeletonOf('привет abc')).toBe('abc')
  })

  it('keeps ordinary phone input readable', () => {
    expect(normalizeText('I’d like my “super saver” balance 👨‍👩‍👧')).toBe('i’d like my “super saver” balance 👨👩👧')
    expect(normalize('Здравствуйте').tokens).toHaveLength(1)
  })

  it('throws only for a non-string', () => {
    expect(() => normalize(undefined as unknown as string)).toThrow(TypeError)
    expect(normalize('')).toEqual({ text: '', tokens: [], skeleton: '' })
  })
})

describe('fold sync with PP-10 (FOLD_TABLES)', () => {
  it('uses NFKC and the same zero-width set', () => {
    expect(FOLD_TABLES.normalization).toBe('NFKC')
    expect([...FOLD_TABLES.zeroWidthCodePoints]).toEqual([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff])
    for (const codePoint of ZERO_WIDTH_CODE_POINTS) {
      expect(normalizeText(`a${String.fromCodePoint(codePoint)}b`)).toBe('ab')
    }
  })

  it('maps every confusable exactly as fold() does, then casefolds', () => {
    expect(FOLD_TABLES.confusables).toBe(CONFUSABLES)
    for (const [key, value] of Object.entries(FOLD_TABLES.confusables)) {
      expect(normalizeText(`x${key}x`), `U+${key.codePointAt(0)?.toString(16)}`).toBe(`x${value.toLowerCase()}x`)
    }
  })

  it('agrees with fold() on text without marks, ignorables, or extra whitespace', () => {
    for (const text of ['Ignоrе ​previous', 'ＡＤＭＩＮ override', 'hеllo wоrld', 'plain ascii text']) {
      expect(normalizeText(text)).toBe(fold(text).toLowerCase())
    }
  })
})
