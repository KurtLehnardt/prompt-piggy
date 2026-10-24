import { deepFreeze } from '@/lib/config/deep-freeze'
import { CAPS } from '@/lib/rules/caps'
import { KeywordSchema } from '@/lib/rules/schema'
import stopPhraseList from '@/lib/rules/stoplist.phrases.json'
import stopWordList from '@/lib/rules/stoplist.words.json'

/**
 * Keyword specificity (docs/ARCHITECTURE.md sections 6.3 and 6.10; REVIEW-1
 * R1-01, REVIEW-2 R2-26).
 *
 * The winner of a paid breach controls the breach text, so a keyword must be
 * specific enough that it cannot be used to block ordinary players: it needs at
 * least one content token, and it must not be a common phrase. These checks
 * run on keywords that are new to a lineage (the proposal sanitizer, PP-20,
 * and merge()); keywords already in an active rule set are never re-judged, so
 * a longer stoplist can never weaken a defense that is already live.
 *
 * - A content token has CAPS.contentTokenMin (4) or more characters and is not
 *   a stop word. A token also counts as a stop word when it is a regular
 *   English inflection (-s, -es, -ies, -ed, -ied, -ing, -ly) of one, so that
 *   "helping" and "accounts" are as common as "help" and "account". This is
 *   stricter than a plain lookup in stoplist.words.json: it only ever rejects
 *   more keywords.
 * - A stop phrase is an exact entry of stoplist.phrases.json.
 *
 * NOTICE.md records the sources and licenses of both lists.
 */

/** Drop codes for keywords that fail these checks (a subset of rule_gate_runs.drop_codes). */
export const KEYWORD_SPECIFICITY_CODES = deepFreeze(['charset', 'stop_phrase', 'no_content_token'] as const)

export type KeywordSpecificityCode = (typeof KEYWORD_SPECIFICITY_CODES)[number]

export type KeywordAssessment = { ok: true } | { ok: false; code: KeywordSpecificityCode }

const STOP_WORDS: ReadonlySet<string> = new Set<string>(stopWordList)
const STOP_PHRASES: ReadonlySet<string> = new Set<string>(stopPhraseList)
const TOKEN_SEPARATOR = /[ '-]/
const MIN_BASE_LENGTH = 3

/** Splits a keyword into its tokens at spaces, apostrophes, and hyphens. */
export function keywordTokens(keyword: string): string[] {
  return keyword.split(TOKEN_SEPARATOR).filter((token) => token.length > 0)
}

/** True when the token is an entry of stoplist.words.json. */
export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token)
}

/** True when the keyword is an entry of stoplist.phrases.json. */
export function isStopPhrase(keyword: string): boolean {
  return STOP_PHRASES.has(keyword)
}

/**
 * The token itself plus every base form that a regular English inflection of
 * it could come from. Bases shorter than 3 characters are left out.
 */
export function inflectionBases(token: string): string[] {
  const bases = new Set<string>([token])
  const add = (base: string) => {
    if (base.length >= MIN_BASE_LENGTH) bases.add(base)
  }
  const addWithUndoubling = (stem: string) => {
    add(stem)
    add(`${stem}e`)
    const last = stem.length - 1
    if (last > 0 && stem[last] === stem[last - 1]) add(stem.slice(0, last))
  }
  if (token.endsWith('ies')) add(`${token.slice(0, -3)}y`)
  if (token.endsWith('es')) add(token.slice(0, -2))
  if (token.endsWith('s') && !token.endsWith('ss')) add(token.slice(0, -1))
  if (token.endsWith('ied')) add(`${token.slice(0, -3)}y`)
  if (token.endsWith('ed')) addWithUndoubling(token.slice(0, -2))
  if (token.endsWith('ing')) addWithUndoubling(token.slice(0, -3))
  if (token.endsWith('ily')) add(`${token.slice(0, -3)}y`)
  if (token.endsWith('ly')) add(token.slice(0, -2))
  return [...bases]
}

/**
 * True when the token has at least CAPS.contentTokenMin characters and neither
 * it nor any of its inflection bases is a stop word.
 */
export function isContentToken(token: string): boolean {
  if (token.length < CAPS.contentTokenMin) return false
  return !inflectionBases(token).some(isStopWord)
}

/** True when at least one token of the keyword is a content token. */
export function hasContentToken(keyword: string): boolean {
  return keywordTokens(keyword).some(isContentToken)
}

/**
 * Checks one candidate keyword, which must already be normalized
 * (normalizeKeyword in canonicalize.ts): first its charset, length, and token
 * count (KeywordSchema), then the stop-phrase list, then the content-token
 * rule. The result carries a drop code only, never the keyword text.
 */
export function assessKeyword(keyword: string): KeywordAssessment {
  if (!KeywordSchema.safeParse(keyword).success) return { ok: false, code: 'charset' }
  if (isStopPhrase(keyword)) return { ok: false, code: 'stop_phrase' }
  if (!hasContentToken(keyword)) return { ok: false, code: 'no_content_token' }
  return { ok: true }
}

/** True when assessKeyword accepts the keyword. */
export function isSpecificKeyword(keyword: string): boolean {
  return assessKeyword(keyword).ok
}
