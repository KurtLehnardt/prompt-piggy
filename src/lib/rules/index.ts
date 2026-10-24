/**
 * The sanitized rule schema (docs/ARCHITECTURE.md section 6; HC1, HC-A1, HC3).
 *
 * Every module here is pure: no I/O, no mutable module state, and deep-frozen
 * data exports. Nothing in a rule set is ever placed in an LLM prompt (section
 * 6.9): the flags only switch code-defined validator detectors, and the
 * keywords are data for deterministic matching.
 */
export { CAPS, KEYWORD_PATTERN, KEYWORD_TOKEN_SEPARATORS } from '@/lib/rules/caps'
export {
  canonicalByteLength,
  canonicalize,
  canonicalJson,
  canonicalSha256,
  compareCodeUnits,
  isWithinRuleSetByteCap,
  normalizeKeyword,
  utf8Bytes,
} from '@/lib/rules/canonicalize'
export {
  DETECTOR_FAMILY_FLAGS,
  FLAG_DETECTOR_FAMILIES,
  FLAG_NAMES,
  familyOfFlag,
  flagOfFamily,
  isFlagName,
  type FlagName,
} from '@/lib/rules/flags'
export {
  MERGE_STATUSES,
  merge,
  RuleMergeError,
  type MergeResult,
  type MergeStatus,
  type RejectedKeyword,
  type RuleMergeErrorCode,
} from '@/lib/rules/merge'
export {
  HardeningProposalSchema,
  KeywordSchema,
  RuleSetSchema,
  type HardeningProposalV1,
  type RuleSetV1,
} from '@/lib/rules/schema'
export { SEED_RULE_SETS } from '@/lib/rules/seed'
export {
  assessKeyword,
  hasContentToken,
  inflectionBases,
  isContentToken,
  isSpecificKeyword,
  isStopPhrase,
  isStopWord,
  KEYWORD_SPECIFICITY_CODES,
  keywordTokens,
  type KeywordAssessment,
  type KeywordSpecificityCode,
} from '@/lib/rules/specificity'
