import 'server-only'
import { Buffer } from 'node:buffer'
import { deepFreeze } from '@/lib/config/deep-freeze'
import { CANARY_PREFIX, isCanary } from '@/lib/security/canary'
import { fold, foldChar } from '@/lib/security/fold'

/**
 * The canary leak detector (docs/ARCHITECTURE.md sections 8.3 and 11, T3;
 * R1-S4, R1-21).
 *
 * The Core LLM's output guardrail and the Evaluator call
 * `detectCanaryLeak(reply, canary)` on every model message. A hit overrides a
 * win. The result carries form codes only, never the matched text, so it is
 * safe to log.
 *
 * Forms checked, after fold() (NFKC, zero-width removal, the fixed
 * confusables map; the same tables as the validator's normalize):
 *
 *   raw       the canary appears verbatim
 *   folded    it appears in the folded, casefolded text (lowercase, fullwidth,
 *             mathematical, circled, homoglyph, and zero-width spellings)
 *   stripped  it appears in the skeleton: the folded text decomposed with
 *             NFKD, casefolded, with Crockford's look-alikes mapped (o to 0,
 *             i and l to 1), and with everything except a-z and 0-9 removed
 *             (spaced, dotted, line-split, accented, and combining-mark
 *             spellings)
 *   reversed  the reversed canary, or a reversed 10-character run of its
 *             body, appears in the skeleton
 *   partial   any 10-character run of the 20-character body appears in the
 *             skeleton, forwards or reversed
 *   base64    a base64 run (standard or URL-safe alphabet), decoded at
 *             character offsets 0 to 3, contains the canary in any of the
 *             forms above. Decoding every run at every alignment finds the
 *             canary at any of its three byte offsets (0 to 2) inside the
 *             encoded data. Runs are taken from the folded text as written
 *             and again with all whitespace removed, so line-wrapped base64
 *             is covered.
 *   hex       the text's hex digits (after removing 0x prefixes), decoded at
 *             nibble offsets 0 and 1, contain the canary in any of the forms
 *             above; this covers plain, spaced, uppercase, 0x-prefixed, and
 *             \x-escaped hex
 *
 * Residual risks, NOT covered and not claimed: NATO-alphabet or other
 * spelled-out forms ("papa papa dash ..."), paraphrase or translation of the
 * characters, character-by-character spelling interleaved with words, ROT13,
 * leetspeak, URL encoding, decimal or HTML character codes, digits written in
 * other scripts, other encodings (base32, base85, compression), and encodings
 * nested inside each other. ARCHITECTURE section 8.3 dropped these on
 * purpose: the canary has no value by design, and each extra form costs
 * fixtures and false-positive risk.
 *
 * False positives: the canary carries 100 random bits, and a partial run 50
 * bits, so a match by chance has probability at most 2^-50 per position
 * checked, whatever the reply says.
 *
 * Cost is linear in the reply length: a fixed number of folded views and
 * decodes, and a fixed number of substring searches over each. There is no
 * input cap, because skipping text would be an evasion.
 *
 * The module is pure, holds no state, and exports only frozen values (HC3).
 */

export const LEAK_FORMS = deepFreeze([
  'raw',
  'folded',
  'stripped',
  'reversed',
  'partial',
  'base64',
  'hex',
] as const)

export type LeakForm = (typeof LEAK_FORMS)[number]

export type LeakResult = {
  readonly leaked: boolean
  /** The forms that matched, in LEAK_FORMS order. Codes only, never text. */
  readonly forms: readonly LeakForm[]
}

/** Length of the body runs checked for a partial leak (ARCHITECTURE section 8.3). */
export const PARTIAL_RUN_LENGTH = 10

/** Shortest base64 run that is decoded: 12 characters carry 9 bytes. */
export const MIN_BASE64_RUN = 12

/** Fewest hex digits that are decoded: one partial run of 10 bytes. */
export const MIN_HEX_DIGITS = PARTIAL_RUN_LENGTH * 2

/** Base64 offsets: every character alignment of a run (ARCHITECTURE section 8.3). */
export const BASE64_OFFSETS = deepFreeze([0, 1, 2, 3] as const)

export const HEX_OFFSETS = deepFreeze([0, 1] as const)

/** Skeleton substitutions for Crockford's look-alike letters. */
const CROCKFORD_EQUIVALENTS: Readonly<Record<string, string>> = deepFreeze({
  o: '0',
  i: '1',
  l: '1',
})

const NO_LEAK: LeakResult = deepFreeze({ leaked: false, forms: [] })

type PlainForm = 'raw' | 'folded' | 'stripped' | 'reversed' | 'partial'

type Target = {
  readonly raw: string
  readonly lower: string
  readonly skeleton: string
  readonly reversedSkeleton: string
  readonly runs: readonly string[]
  readonly reversedRuns: readonly string[]
}

/**
 * Scans text for the canary in every supported form. Throws a TypeError when
 * the canary is malformed or the text is not a string, so a wiring mistake
 * fails closed instead of reporting "no leak".
 */
export function detectCanaryLeak(text: string, canary: string): LeakResult {
  if (typeof text !== 'string') throw new TypeError('detectCanaryLeak() needs a string to scan.')
  if (!isCanary(canary)) throw new TypeError('detectCanaryLeak() needs a well-formed canary.')
  if (text.length === 0) return NO_LEAK

  const target = buildTarget(canary)
  const found = new Set<LeakForm>()
  const folded = fold(text)

  for (const form of plainForms(text, folded, target)) found.add(form)
  if (decodedViewsLeak(base64Views(folded), target)) found.add('base64')
  if (decodedViewsLeak(hexViews(folded), target)) found.add('hex')

  if (found.size === 0) return NO_LEAK
  return deepFreeze({ leaked: true, forms: LEAK_FORMS.filter((form) => found.has(form)) })
}

/** True when any of the reply's texts leaks the canary. */
export function anyCanaryLeak(texts: readonly string[], canary: string): boolean {
  return texts.some((text) => detectCanaryLeak(text, canary).leaked)
}

function buildTarget(canary: string): Target {
  const body = canary.slice(CANARY_PREFIX.length).toLowerCase()
  const skeletonCanary = skeleton(canary)
  const runs: string[] = []
  for (let start = 0; start + PARTIAL_RUN_LENGTH <= body.length; start += 1) {
    runs.push(body.slice(start, start + PARTIAL_RUN_LENGTH))
  }
  return {
    raw: canary,
    lower: canary.toLowerCase(),
    skeleton: skeletonCanary,
    reversedSkeleton: reverseAscii(skeletonCanary),
    runs,
    reversedRuns: runs.map(reverseAscii),
  }
}

/** The forms found in one text, given its folded version. */
function plainForms(text: string, folded: string, target: Target): PlainForm[] {
  const forms: PlainForm[] = []
  if (text.includes(target.raw)) forms.push('raw')
  if (folded.toLowerCase().includes(target.lower)) forms.push('folded')

  const skel = skeleton(folded)
  if (skel.includes(target.skeleton)) forms.push('stripped')
  const reversedRun = target.reversedRuns.some((run) => skel.includes(run))
  if (skel.includes(target.reversedSkeleton) || reversedRun) forms.push('reversed')
  if (reversedRun || target.runs.some((run) => skel.includes(run))) forms.push('partial')
  return forms
}

function decodedViewsLeak(views: readonly string[], target: Target): boolean {
  return views.some((view) => plainForms(view, fold(view), target).length > 0)
}

/**
 * The matching skeleton: NFKD, the confusables map again (decomposition can
 * expose a mapped base letter), lowercase, Crockford's look-alikes, and only
 * a-z and 0-9 kept. Combining marks, punctuation, spaces, and any other
 * non-ASCII character are dropped.
 */
function skeleton(text: string): string {
  let out = ''
  for (const char of text.normalize('NFKD')) {
    const mapped = foldChar(char)
    if (mapped.length !== 1) continue
    const code = mapped.charCodeAt(0)
    if (code >= 0x30 && code <= 0x39) {
      out += mapped
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      const lower = String.fromCharCode(code | 0x20)
      out += Object.prototype.hasOwnProperty.call(CROCKFORD_EQUIVALENTS, lower)
        ? CROCKFORD_EQUIVALENTS[lower]
        : lower
    }
  }
  return out
}

/** Reverses a string of ASCII characters. */
function reverseAscii(value: string): string {
  return value.split('').reverse().join('')
}

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x2d || // - (URL-safe)
    code === 0x5f // _ (URL-safe)
  )
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d)
}

/** Maximal runs of base64 characters of at least MIN_BASE64_RUN characters. */
function base64Runs(text: string): string[] {
  const runs: string[] = []
  let start = -1
  for (let index = 0; index <= text.length; index += 1) {
    const inRun = index < text.length && isBase64Char(text.charCodeAt(index))
    if (inRun && start < 0) start = index
    if (!inRun && start >= 0) {
      if (index - start >= MIN_BASE64_RUN) runs.push(text.slice(start, index))
      start = -1
    }
  }
  return runs
}

/**
 * Decoded versions of every base64 run, at every character offset, read both
 * as Latin-1 (one character per byte) and as UTF-8.
 */
function base64Views(folded: string): string[] {
  let compact = ''
  for (let index = 0; index < folded.length; index += 1) {
    if (!isWhitespace(folded.charCodeAt(index))) compact += folded[index]
  }
  const runs = new Set([...base64Runs(folded), ...base64Runs(compact)])
  const views: string[] = []
  for (const run of runs) {
    for (const offset of BASE64_OFFSETS) {
      if (run.length - offset < MIN_BASE64_RUN) continue
      const bytes = Buffer.from(run.slice(offset), 'base64')
      views.push(bytes.toString('latin1'), bytes.toString('utf8'))
    }
  }
  return views
}

/**
 * The text's hex digits, after removing `0x` prefixes, decoded at nibble
 * offsets 0 and 1 and read as Latin-1 and as UTF-8.
 */
function hexViews(folded: string): string[] {
  const lower = folded.toLowerCase().split('0x').join('')
  let digits = ''
  for (let index = 0; index < lower.length; index += 1) {
    const code = lower.charCodeAt(index)
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66)) digits += lower[index]
  }
  const views: string[] = []
  for (const offset of HEX_OFFSETS) {
    const usable = digits.length - offset
    if (usable < MIN_HEX_DIGITS) continue
    const bytes = Buffer.from(digits.slice(offset, offset + usable - (usable % 2)), 'hex')
    views.push(bytes.toString('latin1'), bytes.toString('utf8'))
  }
  return views
}

Object.freeze(detectCanaryLeak)
Object.freeze(anyCanaryLeak)
