import 'server-only'
import { deepFreeze } from '@/lib/config/deep-freeze'
import type { ResolvedLevelConfig } from '@/lib/config/level-secrets'
import { flagOfFamily } from '@/lib/rules/flags'
import { PROMPT_CHARS_HARD_MAX } from '@/types/api'
import { DETECTOR_VERSION } from '@/lib/validator/detector-phrases'
import { analyze, detectFamilies, type ExtraPhrases } from '@/lib/validator/detectors'
import { matchesAnyKeyword } from '@/lib/validator/keywords'
import type { ReasonCode, SignalCode } from '@/lib/validator/reasons'
import type { ValidateOptions, ValidatorResult, ValidatorRules } from '@/lib/validator/types'

/**
 * The Dynamic Validator, deterministic part (docs/ARCHITECTURE.md section
 * 8.1; HC1, HC3, HC-A1, HC-A4).
 *
 * validate(input, rules, level) is a pure function of its arguments. The
 * attempt service (src/lib/game/attempt-service.ts, POST /api/attempts) and
 * the hardening gate call it on the Node runtime before any OpenAI spend. It
 * is never imported by src/proxy.ts (scripts/check-proxy-scope.mjs).
 *
 * Pipeline: a length cap (MAX_PROMPT_CHARS, passed by the caller), a
 * control-character check, normalization, bounded decode probes, the detector
 * families, then `block_keywords` matching. A detected family blocks when its
 * flag is on and is a signal otherwise; a matched keyword always blocks.
 *
 * The result holds reason and signal codes only, never matched text. The
 * function keeps no state, reads no environment, and takes no game state:
 * no crack count, wallet balance, aura, or session (HC3, HC-A5).
 */

export { blockTechnique, BLOCK_REASON_TECHNIQUES, REASON_CODES, SIGNAL_CODES } from '@/lib/validator/reasons'
export { DETECTOR_VERSION } from '@/lib/validator/detector-phrases'
export { fingerprint, FINGERPRINT_PREFIX } from '@/lib/validator/fingerprint'
export { normalize } from '@/lib/validator/normalize'
export type {
  NormalizedText,
  ReasonCode,
  SignalCode,
  ValidateOptions,
  ValidatorResult,
  ValidatorRules,
  ValidatorVerdict,
} from '@/lib/validator/types'

/** MAX_PROMPT_CHARS when the caller passes none (section 8.1). */
export const DEFAULT_MAX_PROMPT_CHARS = 2000

function result(reasons: ReasonCode[], signals: SignalCode[]): ValidatorResult {
  return deepFreeze({
    verdict: reasons.length > 0 ? 'block' : 'allow',
    reasons,
    signals,
    detectorVersion: DETECTOR_VERSION,
  })
}

function maxCharsOf(options: ValidateOptions | undefined): number {
  const value = options?.maxChars
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return DEFAULT_MAX_PROMPT_CHARS
  return Math.min(value, PROMPT_CHARS_HARD_MAX)
}

/**
 * True when the text has a C0 control character other than tab, line feed,
 * and carriage return, DEL, a C1 control character, or a lone surrogate.
 */
function hasControlCharacters(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code >= 0x7f && code <= 0x9f) return true
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

/** The extra detector phrases of a resolved level 4 or 5 configuration. */
function extraPhrasesOf(level: ResolvedLevelConfig): ExtraPhrases {
  if (level === null || typeof level !== 'object' || level.secret !== true) return {}
  return level.secretMaterial?.extraDetectorPhrases ?? {}
}

export function validate(
  input: string,
  rules: ValidatorRules,
  level: ResolvedLevelConfig,
  options?: ValidateOptions
): ValidatorResult {
  if (rules === null || typeof rules !== 'object') throw new TypeError('validate() needs a rule set.')
  if (typeof input !== 'string') return result(['invalid_input'], [])
  if (input.length > maxCharsOf(options)) return result(['too_long'], [])
  if (hasControlCharacters(input)) return result(['control_chars'], [])

  const analysis = analyze(input)
  const families = detectFamilies(input, analysis, extraPhrasesOf(level))
  const reasons: ReasonCode[] = []
  const signals: SignalCode[] = []
  for (const family of families) {
    if (rules[flagOfFamily(family)] === true) reasons.push(family)
    else signals.push(family)
  }

  const keywords: readonly unknown[] = Array.isArray(rules.block_keywords) ? rules.block_keywords : []
  if (keywords.length > 0 && matchesAnyKeyword(keywords, analysis.primary, [analysis.reversed, ...analysis.decoded])) {
    reasons.push('keyword')
  }
  return result(reasons, signals)
}

Object.freeze(validate)
