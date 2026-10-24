import { deepFreeze } from '@/lib/config/deep-freeze'
import { fold, foldConfusables } from '@/lib/security/fold'
import {
  COMBINING_MARK,
  DEFAULT_IGNORABLE,
  WHITESPACE,
  WORD_CHAR,
} from '@/lib/validator/detector-phrases'
import type { NormalizedText } from '@/lib/validator/types'

/**
 * Normalization for the Dynamic Validator (docs/ARCHITECTURE.md sections 8.1
 * and 6.3; R1-01, R1-21).
 *
 * normalize() starts with fold() from src/lib/security/fold.ts (PP-10), so the
 * validator and the canary leak detector share one set of tables: NFKC, the
 * zero-width characters U+200B to U+200F, U+2060, and U+FEFF, and the fixed
 * confusables map (fold-sync.test.ts in normalize.test.ts pins this). Then it
 *
 *   1. decomposes with NFKD and removes combining marks and the remaining
 *      default-ignorable characters (soft hyphens, variation selectors, and
 *      the like), so accents, Zalgo marks, and invisible fillers cannot split
 *      or disguise a word;
 *   2. applies the confusables map again, for look-alikes that only appear
 *      after decomposition (Cyrillic "ё" becomes "е", which maps to "e");
 *   3. casefolds with toLowerCase and recomposes with NFC (Hangul syllables);
 *   4. collapses whitespace: a run that contains a line break becomes one
 *      `\n`, any other run one space, and the ends are trimmed.
 *
 * The result only rewrites text for matching. It never decides anything, so
 * ordinary phone input (smart quotes, accents, emoji, ZWJ sequences, whole
 * messages in one non-Latin script) passes through it harmlessly; the
 * `mixed_script` detector looks at the text before normalization.
 *
 * Every function is pure and the module holds no state (HC3).
 */

export const NORMALIZE_STEPS = deepFreeze([
  'nfkc',
  'zero_width',
  'confusables',
  'nfkd_strip_marks',
  'default_ignorable',
  'confusables_after_decomposition',
  'casefold',
  'nfc',
  'whitespace',
] as const)

/** Removes combining marks and default-ignorable characters from NFKD text. */
function stripMarksAndIgnorables(text: string): string {
  let out = ''
  for (const char of text.normalize('NFKD')) {
    if (COMBINING_MARK.test(char) || DEFAULT_IGNORABLE.test(char)) continue
    out += char
  }
  return out
}

/** Collapses whitespace runs: one with a line break becomes `\n`, others a space. */
function collapseWhitespace(text: string): string {
  let out = ''
  let pending: '' | ' ' | '\n' = ''
  for (const char of text) {
    if (WHITESPACE.test(char)) {
      if (char === '\n' || char === '\r' || char === ' ' || char === ' ' || char === '\v' || char === '\f') {
        pending = '\n'
      } else if (pending === '') {
        pending = ' '
      }
      continue
    }
    if (pending !== '' && out.length > 0) out += pending
    pending = ''
    out += char
  }
  return out
}

/** The maximal runs of letters and digits (any script) of a normalized text. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const char of text) {
    if (WORD_CHAR.test(char)) {
      current += char
    } else if (current !== '') {
      tokens.push(current)
      current = ''
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** The text with everything except a-z and 0-9 removed. */
export function skeletonOf(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) out += text[index]
  }
  return out
}

/** The normalized string form only (section 8.1). */
export function normalizeText(input: string): string {
  if (typeof input !== 'string') throw new TypeError('normalize() needs a string.')
  const folded = fold(input)
  const stripped = stripMarksAndIgnorables(folded)
  const refolded = foldConfusables(stripped)
  const lowered = refolded.toLowerCase().normalize('NFC')
  return collapseWhitespace(lowered)
}

/**
 * The normalized views of a text: the normalized string, its tokens, and its
 * letters-and-digits skeleton. Exported for the leak detector and the
 * hardening pipeline (R1-21).
 */
export function normalize(input: string): NormalizedText {
  const text = normalizeText(input)
  return { text, tokens: tokenize(text), skeleton: skeletonOf(text) }
}

Object.freeze(tokenize)
Object.freeze(skeletonOf)
Object.freeze(normalizeText)
Object.freeze(normalize)
