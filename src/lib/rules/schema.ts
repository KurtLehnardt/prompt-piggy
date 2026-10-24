import { z } from 'zod'
import { ENGINE_TECHNIQUES } from '@/lib/config/techniques'
import { CAPS, KEYWORD_PATTERN } from '@/lib/rules/caps'
import { isWithinRuleSetByteCap } from '@/lib/rules/canonicalize'
import { FLAG_NAMES, type FlagName } from '@/lib/rules/flags'

/**
 * The rule set and Hardening Engine proposal schemas (docs/ARCHITECTURE.md
 * section 6.1; HC1, HC-A1, HC-A2).
 *
 * A rule set has exactly two kinds of fields: booleans that switch on
 * code-defined detectors, and one capped, charset-restricted string array that
 * the deterministic validator matches as data. There is no free-text field of
 * any kind, and none may ever be added: extending the catalog means adding a
 * boolean flag backed by a detector (src/lib/rules/flags.ts).
 *
 * These zod schemas are authoritative. rule-set.schema.json and
 * proposal.schema.json are generated from them with z.toJSONSchema
 * (`pnpm rules:schema`), and json-schema-sync.test.ts fails on drift.
 */

/** One `block_keywords` entry: 8 to 48 characters, 2 to 4 lowercase ASCII tokens. */
export const KeywordSchema = z
  .string()
  .min(CAPS.keywordMin)
  .max(CAPS.keywordMax)
  .regex(new RegExp(KEYWORD_PATTERN))

const PROPOSAL_FLAG_DESCRIPTION = 'true enables this detector; false means no change'

function flagShape(description?: string): Record<FlagName, z.ZodBoolean> {
  return Object.fromEntries(
    FLAG_NAMES.map((flag) => [flag, description ? z.boolean().describe(description) : z.boolean()])
  ) as Record<FlagName, z.ZodBoolean>
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/** A stored rule set, version 1. */
export const RuleSetSchema = z
  .strictObject({
    schema_version: z.literal(CAPS.schemaVersion),
    block_keywords: z
      .array(KeywordSchema)
      .max(CAPS.keywordsPerRuleSet)
      .refine(isUnique, 'duplicate keyword')
      .meta({ uniqueItems: true }),
    ...flagShape(),
  })
  .refine(isWithinRuleSetByteCap, 'rule set too large')
  .meta({
    title: 'PromptPiggyRuleSetV1',
    description: `At most ${CAPS.ruleSetBytes} bytes of canonical JSON (keys and keywords sorted).`,
  })

/**
 * The Hardening Engine's structured output (sent as the strict json_schema
 * format, HC-A2). A false flag means "no change", so a proposal can only add
 * defenses. `technique` is display metadata from ENGINE_TECHNIQUES (never
 * `unknown`, R2-S3) and never selects a flag or keyword (CH-6b).
 */
export const HardeningProposalSchema = z.strictObject({
  technique: z.enum(ENGINE_TECHNIQUES),
  block_keywords: z.array(KeywordSchema).max(CAPS.keywordsPerProposal),
  ...flagShape(PROPOSAL_FLAG_DESCRIPTION),
})

export type RuleSetV1 = z.infer<typeof RuleSetSchema>
export type HardeningProposalV1 = z.infer<typeof HardeningProposalSchema>
export type { FlagName } from '@/lib/rules/flags'
