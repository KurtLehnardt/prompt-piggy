import { deepFreeze } from '@/lib/config/deep-freeze'
import { DETECTOR_FAMILIES, isDetectorFamily, type DetectorFamily } from '@/lib/config/detector-families'
import { CONFUSABLES, isZeroWidth } from '@/lib/security/fold'
import { decodeProbes, reversedText } from '@/lib/validator/decode'
import {
  ANY_LETTER,
  ASCII_LETTER,
  BASE_PHRASES,
  CONFUSABLE_SCRIPT_LETTER,
  DELIMITER_PATTERNS,
  EMOJI_MODIFIER,
  EXTENDED_PICTOGRAPHIC,
  LATIN_LETTER,
  PHRASE_FAMILIES,
  WORD_CHAR,
  type PhraseFamily,
} from '@/lib/validator/detector-phrases'
import { phraseMatches, toPattern, type MatchView, type TokenPattern } from '@/lib/validator/keywords'
import { normalize, skeletonOf, tokenize } from '@/lib/validator/normalize'
import type { DecodedRun, NormalizedText } from '@/lib/validator/types'

/**
 * The deterministic detector families (docs/ARCHITECTURE.md section 6.2;
 * T5, T24, T26).
 *
 * Every family always runs. validate() turns a detected family into a block
 * reason when the rule set's flag for it is on, and into a signal otherwise.
 *
 * - Phrase families (roleplay, authority, override, tool, deferred,
 *   hypothetical): the BASE_PHRASES token sequences, plus a level 4 or 5
 *   payload's extra phrases, in the normalized message, the reversed message,
 *   and each decoded run.
 * - delimiter: the fixed DELIMITER_PATTERNS on the normalized message and on
 *   each decoded run.
 * - decode: at least one base64, hex, URL-encoded, or decimal run that
 *   decodes to 12 or more printable characters.
 * - mixed_script: see detectMixedScript().
 *
 * Extra phrases for the delimiter, decode, and mixed_script families are
 * matched as token sequences too, and detect their family.
 *
 * Every function is pure and the module holds no state (HC3).
 */

/** The catalog phrases, tokenized once. Frozen. */
export const BASE_PATTERNS = deepFreeze(
  Object.fromEntries(
    PHRASE_FAMILIES.map((family) => [family, BASE_PHRASES[family].map((phrase) => toPattern(phrase, true))])
  ) as Record<PhraseFamily, TokenPattern[]>
)

/** Every view the detectors search, built once per message. */
export type Analysis = {
  readonly primary: NormalizedText
  readonly reversed: MatchView
  readonly decodedRuns: readonly DecodedRun[]
  readonly decoded: readonly NormalizedText[]
}

/** Builds the normalized, reversed, and decoded views of a message. */
export function analyze(input: string): Analysis {
  const primary = normalize(input)
  const decodedRuns = decodeProbes(input)
  const decoded = decodedRuns.map((run) => normalize(run.text))
  const reversed = reversedText(primary.text)
  return {
    primary,
    reversed: { tokens: tokenize(reversed), skeleton: skeletonOf(reversed) },
    decodedRuns,
    decoded,
  }
}

/**
 * Invisible characters that can split or disguise a word: the zero-width set
 * of fold.ts plus the soft hyphen, the combining grapheme joiner, the Arabic
 * letter mark, the Mongolian vowel separator, the invisible operators, the
 * bidirectional embedding, override, and isolate controls, and the Hangul
 * fillers.
 */
function isInvisible(codePoint: number): boolean {
  return (
    isZeroWidth(codePoint) ||
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x180e ||
    (codePoint >= 0x2061 && codePoint <= 0x2064) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x3164 ||
    codePoint === 0xffa0
  )
}

function isEmojiJoinerLeft(char: string | undefined): boolean {
  if (char === undefined) return false
  return EXTENDED_PICTOGRAPHIC.test(char) || EMOJI_MODIFIER.test(char) || char === '️' || char === '⃣'
}

function isNonLatinLetterOrMark(char: string | undefined): boolean {
  if (char === undefined || !WORD_CHAR.test(char)) return false
  const code = char.codePointAt(0) as number
  if (code >= 0x30 && code <= 0x39) return false
  return !LATIN_LETTER.test(char)
}

/**
 * True for a zero-width joiner or non-joiner that ordinary text uses: U+200D
 * inside an emoji ZWJ sequence (a pictograph, optionally with a skin tone or
 * VS16, then U+200D, then a pictograph), and U+200C or U+200D between two
 * letters of a non-Latin script that uses joiners (Persian, Hindi, and
 * others). Any other invisible character is "stray" (PR #8 review, H3).
 */
function isOrdinaryJoiner(chars: readonly string[], index: number): boolean {
  const char = chars[index]
  const previous = chars[index - 1]
  const next = chars[index + 1]
  if (char === '‍' && next !== undefined && EXTENDED_PICTOGRAPHIC.test(next) && isEmojiJoinerLeft(previous)) {
    return true
  }
  if (char === '‌' || char === '‍') {
    return isNonLatinLetterOrMark(previous) && isNonLatinLetterOrMark(next)
  }
  return false
}

/** True when the confusables map has a non-Latin key for this character (Cyrillic, Greek, ...). */
function isNonLatinConfusable(char: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONFUSABLES, char) && !LATIN_LETTER.test(char)
}

/**
 * The `mixed_script` detector (section 6.2), tuned so that ordinary phone
 * input never matches (PR #8 review, H3). It is true when the message has
 *
 *   1. a stray invisible character (see isOrdinaryJoiner for the joiners
 *      that are allowed), or
 *   2. a word that mixes ASCII letters with Cyrillic, Greek, Armenian, or
 *      Cherokee letters, or
 *   3. three or more non-Latin look-alike characters while ASCII letters are
 *      the majority of its letters.
 *
 * A whole message in one non-Latin script has no ASCII letters, so rules 2
 * and 3 cannot match it; accented Latin, smart quotes, and emoji contain no
 * look-alikes of another script. The check runs on the NFKC form of the raw
 * message, before folding removes the evidence.
 */
export function detectMixedScript(input: string): boolean {
  const chars = Array.from(input.normalize('NFKC'))
  let confusables = 0
  let asciiLetters = 0
  let letters = 0
  let wordHasAscii = false
  let wordHasOtherScript = false
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const codePoint = char.codePointAt(0) as number
    if (isInvisible(codePoint)) {
      if (!isOrdinaryJoiner(chars, index)) return true
      continue
    }
    if (WORD_CHAR.test(char)) {
      if (ASCII_LETTER.test(char)) {
        wordHasAscii = true
        asciiLetters += 1
      } else if (CONFUSABLE_SCRIPT_LETTER.test(char)) {
        wordHasOtherScript = true
      }
      if (ANY_LETTER.test(char)) letters += 1
      if (isNonLatinConfusable(char)) confusables += 1
      if (wordHasAscii && wordHasOtherScript) return true
      continue
    }
    wordHasAscii = false
    wordHasOtherScript = false
  }
  return confusables >= 3 && asciiLetters * 2 > letters
}

/** True when a fixed DELIMITER pattern matches the normalized text. */
export function hasDelimiterTokens(text: string): boolean {
  return DELIMITER_PATTERNS.some((pattern) => pattern.test(text))
}

/** Operator phrases from a level 4 or 5 payload, keyed by family. */
export type ExtraPhrases = Readonly<Partial<Record<DetectorFamily, readonly string[]>>>

/**
 * The detector families found in a message, in catalog order. `input` is the
 * raw message; `analysis` is analyze(input).
 */
export function detectFamilies(input: string, analysis: Analysis, extraPhrases: ExtraPhrases = {}): DetectorFamily[] {
  const views: MatchView[] = [analysis.primary, analysis.reversed, ...analysis.decoded]
  const found: DetectorFamily[] = []
  for (const family of DETECTOR_FAMILIES) {
    if (familyDetected(family, input, analysis, views) || extraPhraseDetected(extraPhrases, family, views)) {
      found.push(family)
    }
  }
  return found
}

function familyDetected(
  family: DetectorFamily,
  input: string,
  analysis: Analysis,
  views: readonly MatchView[]
): boolean {
  switch (family) {
    case 'delimiter':
      return hasDelimiterTokens(analysis.primary.text) || analysis.decoded.some((view) => hasDelimiterTokens(view.text))
    case 'decode':
      return analysis.decodedRuns.length > 0
    case 'mixed_script':
      return detectMixedScript(input)
    default:
      return BASE_PATTERNS[family].some((pattern) => phraseMatches(pattern, views))
  }
}

function extraPhraseDetected(extraPhrases: ExtraPhrases, family: DetectorFamily, views: readonly MatchView[]): boolean {
  if (!isDetectorFamily(family) || !Object.prototype.hasOwnProperty.call(extraPhrases, family)) return false
  const phrases = extraPhrases[family]
  if (!Array.isArray(phrases)) return false
  return phrases.some((phrase) => typeof phrase === 'string' && phraseMatches(toPattern(phrase), views))
}

Object.freeze(analyze)
Object.freeze(detectMixedScript)
Object.freeze(hasDelimiterTokens)
Object.freeze(detectFamilies)
