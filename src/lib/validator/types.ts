import type { DeepReadonly } from '@/lib/config/deep-freeze'
import type { RuleSetV1 } from '@/lib/rules/schema'
import type { ReasonCode, SignalCode } from '@/lib/validator/reasons'

/**
 * Types of the Dynamic Validator (docs/ARCHITECTURE.md section 8.1).
 */

export type { ReasonCode, SignalCode } from '@/lib/validator/reasons'
export type { ResolvedLevelConfig } from '@/lib/config/level-secrets'

export type ValidatorVerdict = 'allow' | 'block'

/**
 * The validator's answer for one message. It holds codes only, never the
 * matched text or keyword.
 *
 * Section 8.1 also lists `durationMs`. It is left out on purpose: the result
 * must be a pure function of the arguments (HC3, stateless.test.ts), and a
 * timing would differ between two identical calls. The attempt service times
 * the call itself.
 */
export type ValidatorResult = {
  readonly verdict: ValidatorVerdict
  /** Why the message is blocked, in a fixed order; empty when allowed. */
  readonly reasons: readonly ReasonCode[]
  /** Detector families that matched while their flag was off, in catalog order. */
  readonly signals: readonly SignalCode[]
  /** DETECTOR_VERSION of the catalog that produced the result. */
  readonly detectorVersion: number
}

/** A rule set as stored, or as returned frozen by a loader. */
export type ValidatorRules = RuleSetV1 | DeepReadonly<RuleSetV1>

export type ValidateOptions = {
  /**
   * MAX_PROMPT_CHARS from the environment, read by the caller (the validator
   * reads nothing but its arguments). Defaults to DEFAULT_MAX_PROMPT_CHARS and
   * is clamped to PROMPT_CHARS_HARD_MAX.
   */
  readonly maxChars?: number
}

/**
 * The normalized views of one text (section 8.1, "Pipeline").
 *
 * - `text`: NFKC, zero-width removal, the confusables map, removal of other
 *   default-ignorable characters and of combining marks, casefolding, and
 *   whitespace collapse (each run with a line break becomes one `\n`, every
 *   other run one space). Punctuation is kept for the delimiter detector.
 * - `tokens`: the maximal runs of letters and digits of `text`.
 * - `skeleton`: `text` with everything except a-z and 0-9 removed.
 */
export type NormalizedText = {
  readonly text: string
  readonly tokens: readonly string[]
  readonly skeleton: string
}

export type DecodeKind = 'base64' | 'hex' | 'url' | 'decimal'

/** One encoded run that decoded to printable text. */
export type DecodedRun = {
  readonly kind: DecodeKind
  readonly text: string
}
