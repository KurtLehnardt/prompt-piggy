import { deepFreeze, type DeepReadonly } from '@/lib/config/deep-freeze'
import { CAPS } from '@/lib/rules/caps'
import { canonicalize, compareCodeUnits, isWithinRuleSetByteCap } from '@/lib/rules/canonicalize'
import { FLAG_NAMES, type FlagName } from '@/lib/rules/flags'
import {
  HardeningProposalSchema,
  RuleSetSchema,
  type HardeningProposalV1,
  type RuleSetV1,
} from '@/lib/rules/schema'
import { assessKeyword, type KeywordSpecificityCode } from '@/lib/rules/specificity'

/**
 * Monotonic merge of a parent rule set and a sanitized proposal
 * (docs/ARCHITECTURE.md section 6.4; HC1, REVIEW-1 R1-11b).
 *
 * - Every flag of the result is `parent[flag] || proposal[flag]`, so a
 *   proposal's false means "no change" and nothing can switch a detector off.
 * - The result's keywords are the parent's keywords plus the proposal's new
 *   keywords that pass the specificity rules and fit the caps. Parent keywords
 *   are always kept.
 * - When the merge adds nothing, the result is a copy of the parent and the
 *   status is `no_change`. Otherwise the result is canonical (sorted keys and
 *   sorted keywords).
 * - When a new keyword does not fit CAPS.keywordsPerRuleSet (or the byte cap),
 *   the status is `saturated`: new keywords are taken in code-unit order and
 *   kept while they fit, and the rest are reported in `overCapKeywords`.
 *   Saturation is never a review condition (R1-11b).
 *
 * `technique` is display metadata and never affects the result (CH-6b). The
 * function is pure: it never changes its arguments, which may be frozen.
 */

export const MERGE_STATUSES = deepFreeze(['changed', 'no_change', 'saturated'] as const)

export type MergeStatus = (typeof MERGE_STATUSES)[number]

export type RejectedKeyword = { keyword: string; code: KeywordSpecificityCode }

export type MergeResult = {
  status: MergeStatus
  /** True when the result differs from the parent. */
  changed: boolean
  ruleSet: RuleSetV1
  /** Flags that were false in the parent and are true in the result, in catalog order. */
  addedFlags: FlagName[]
  /** New keywords in the result, sorted. */
  addedKeywords: string[]
  /** New keywords left out because the result was full, sorted. */
  overCapKeywords: string[]
  /** New keywords left out because they failed the specificity rules, sorted. */
  rejectedKeywords: RejectedKeyword[]
}

export type RuleMergeErrorCode = 'invalid_parent' | 'invalid_proposal' | 'invalid_result'

/**
 * Thrown when an input fails its schema, or when the result would (it cannot,
 * by construction). The message is fixed text and never quotes an input.
 */
export class RuleMergeError extends Error {
  readonly code: RuleMergeErrorCode

  constructor(code: RuleMergeErrorCode) {
    super(`Rule merge failed: ${code}.`)
    this.name = 'RuleMergeError'
    this.code = code
  }
}

export function merge(
  parent: DeepReadonly<RuleSetV1>,
  proposal: DeepReadonly<HardeningProposalV1>
): MergeResult {
  const parsedParent = RuleSetSchema.safeParse(parent)
  if (!parsedParent.success) throw new RuleMergeError('invalid_parent')
  const parsedProposal = HardeningProposalSchema.safeParse(proposal)
  if (!parsedProposal.success) throw new RuleMergeError('invalid_proposal')
  const base = parsedParent.data
  const delta = parsedProposal.data

  const flags = Object.fromEntries(
    FLAG_NAMES.map((flag) => [flag, base[flag] || delta[flag]])
  ) as Record<FlagName, boolean>
  const addedFlags = FLAG_NAMES.filter((flag) => !base[flag] && delta[flag])

  const existing = new Set(base.block_keywords)
  const candidates = [...new Set(delta.block_keywords)]
    .filter((keyword) => !existing.has(keyword))
    .sort(compareCodeUnits)

  const rejectedKeywords: RejectedKeyword[] = []
  const addedKeywords: string[] = []
  const overCapKeywords: string[] = []
  for (const keyword of candidates) {
    const assessment = assessKeyword(keyword)
    if (!assessment.ok) {
      rejectedKeywords.push({ keyword, code: assessment.code })
      continue
    }
    const trial = buildRuleSet(flags, [...base.block_keywords, ...addedKeywords, keyword])
    if (trial.block_keywords.length <= CAPS.keywordsPerRuleSet && isWithinRuleSetByteCap(trial)) {
      addedKeywords.push(keyword)
    } else {
      overCapKeywords.push(keyword)
    }
  }

  const changed = addedFlags.length > 0 || addedKeywords.length > 0
  const ruleSet = changed
    ? canonicalize(buildRuleSet(flags, [...base.block_keywords, ...addedKeywords]))
    : base
  if (!RuleSetSchema.safeParse(ruleSet).success) throw new RuleMergeError('invalid_result')

  return {
    status: overCapKeywords.length > 0 ? 'saturated' : changed ? 'changed' : 'no_change',
    changed,
    ruleSet,
    addedFlags,
    addedKeywords,
    overCapKeywords,
    rejectedKeywords,
  }
}

function buildRuleSet(flags: Record<FlagName, boolean>, keywords: string[]): RuleSetV1 {
  return { schema_version: CAPS.schemaVersion, block_keywords: keywords, ...flags }
}
