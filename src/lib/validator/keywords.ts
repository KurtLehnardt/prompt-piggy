import { NUMBER_WILDCARD, NUMBER_WORDS } from '@/lib/validator/detector-phrases'
import { normalizeText, tokenize } from '@/lib/validator/normalize'

/**
 * Deterministic token-sequence matching for `block_keywords` and detector
 * phrases (docs/ARCHITECTURE.md sections 6.3 and 8.1; HC-A1, R1-01, R2-12).
 *
 * Keywords are data: they are compared with indexOf over arrays of tokens,
 * and no regular expression is ever built from them. A keyword matches only
 * as a whole token sequence of the normalized message, so "thank you" never
 * matches "thankyou" or "thank youth". The letters-only skeleton and the
 * decoded forms (decode probes and reversed text) are searched only for
 * keywords with more than SKELETON_MIN_LETTERS - 1 letters, which keeps short
 * phrases from matching across word boundaries.
 *
 * Section 6.3 says "8 or more letters". R1-01's own example, "thank you",
 * has exactly 8 letters and must never match "thankyou", so the bound here is
 * 9: strictly more than 8.
 *
 * Every function is pure and the module holds no state (HC3).
 */

export const SKELETON_MIN_LETTERS = 9

/** A keyword or phrase prepared for matching. */
export type TokenPattern = {
  readonly tokens: readonly string[]
  /** The tokens joined without separators, for skeleton search. */
  readonly letters: string
}

/** One searchable form of a message. */
export type MatchView = {
  readonly tokens: readonly string[]
  readonly skeleton: string
}

/**
 * Prepares a keyword or phrase: the same normalization and tokenization as a
 * message. Only the fixed catalog (detectors.ts) passes `allowWildcard`, so a
 * keyword or an operator phrase can never act as a wildcard.
 */
export function toPattern(phrase: string, allowWildcard = false): TokenPattern {
  const tokens: string[] = []
  if (typeof phrase === 'string') {
    for (const part of phrase.split(' ')) {
      if (allowWildcard && part === NUMBER_WILDCARD) tokens.push(NUMBER_WILDCARD)
      else tokens.push(...tokenize(normalizeText(part)))
    }
  }
  return { tokens, letters: tokens.join('') }
}

function tokenMatches(patternToken: string, token: string): boolean {
  if (patternToken !== NUMBER_WILDCARD) return patternToken === token
  if (token.length === 0) return false
  let digits = true
  for (let index = 0; digits && index < token.length; index += 1) {
    const code = token.charCodeAt(index)
    if (code < 0x30 || code > 0x39) digits = false
  }
  return digits || (NUMBER_WORDS as readonly string[]).includes(token)
}

/**
 * True when `sequence` occurs as consecutive whole tokens of `tokens`. The
 * first token is found with indexOf; a NUMBER_WILDCARD first token is scanned.
 */
export function containsTokenSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) return false
  const first = sequence[0]
  const last = tokens.length - sequence.length
  if (first === NUMBER_WILDCARD) {
    for (let start = 0; start <= last; start += 1) {
      if (sequenceAt(tokens, sequence, start)) return true
    }
    return false
  }
  let start = tokens.indexOf(first)
  while (start !== -1 && start <= last) {
    if (sequenceAt(tokens, sequence, start)) return true
    start = tokens.indexOf(first, start + 1)
  }
  return false
}

function sequenceAt(tokens: readonly string[], sequence: readonly string[], start: number): boolean {
  for (let offset = 0; offset < sequence.length; offset += 1) {
    if (!tokenMatches(sequence[offset], tokens[start + offset])) return false
  }
  return true
}

/**
 * True when the pattern matches the primary view as a token sequence, or,
 * for a pattern of at least SKELETON_MIN_LETTERS letters, the primary
 * skeleton or any secondary (decoded or reversed) view's tokens or skeleton.
 */
export function patternMatches(
  pattern: TokenPattern,
  primary: MatchView,
  secondary: readonly MatchView[]
): boolean {
  if (pattern.tokens.length === 0) return false
  if (containsTokenSequence(primary.tokens, pattern.tokens)) return true
  if (pattern.letters.length < SKELETON_MIN_LETTERS || pattern.tokens.includes(NUMBER_WILDCARD)) return false
  if (primary.skeleton.includes(pattern.letters)) return true
  for (const view of secondary) {
    if (containsTokenSequence(view.tokens, pattern.tokens)) return true
    if (view.skeleton.includes(pattern.letters)) return true
  }
  return false
}

/**
 * True when any `block_keywords` entry matches (section 6.3). Entries that
 * are not strings, or that normalize to no tokens, are ignored. The caller
 * learns only that a keyword matched, never which one.
 */
export function matchesAnyKeyword(
  keywords: readonly unknown[],
  primary: MatchView,
  secondary: readonly MatchView[]
): boolean {
  for (const keyword of keywords) {
    if (typeof keyword !== 'string') continue
    if (patternMatches(toPattern(keyword), primary, secondary)) return true
  }
  return false
}

/**
 * True when a phrase matches as a token sequence in any view. Detector
 * phrases are searched in the decoded and reversed views at any length,
 * because token matching never crosses a word boundary, but never in a
 * skeleton.
 */
export function phraseMatches(pattern: TokenPattern, views: readonly MatchView[]): boolean {
  if (pattern.tokens.length === 0) return false
  for (const view of views) {
    if (containsTokenSequence(view.tokens, pattern.tokens)) return true
  }
  return false
}

Object.freeze(toPattern)
Object.freeze(containsTokenSequence)
Object.freeze(patternMatches)
Object.freeze(matchesAnyKeyword)
Object.freeze(phraseMatches)
