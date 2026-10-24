import { z } from 'zod'
import { deepFreeze, type DeepReadonly } from '@/lib/config/deep-freeze'
import { DETECTOR_FAMILIES, type DetectorFamily } from '@/lib/config/detector-families'
import type { LevelConfig, PublicLevelId, SecretLevelId } from '@/lib/config/levels'

/**
 * Level 4 and 5 secret material (docs/ARCHITECTURE.md section 6.2, R2-12).
 *
 * The repository is public, so the level 4 and 5 transfer policy, fragments,
 * tripwire threshold, Decisions predicate text, and extra detector phrases
 * live only in the service-role table `level_secrets`. This module holds the
 * payload schema, the types, and the resolver. The only committed payloads are
 * the synthetic placeholders in __fixtures__/level-secrets.placeholder.json.
 *
 * The SQL function `level_secret_payload_ok` (PP-07) mirrors this schema as
 * defense in depth; zod stays authoritative in TypeScript. The database also
 * caps the whole payload at 16,384 bytes of jsonb text, a bound that only
 * makes SQL stricter than this schema.
 *
 * Nothing here ever prints a payload value: error messages name paths only.
 */

/**
 * One extra detector phrase: 1 to 6 tokens of ASCII lowercase letters and
 * digits separated by single spaces, apostrophes, or hyphens. Phrases are
 * matched as token sequences, never compiled into a RegExp, and never placed
 * in any prompt (HC-A1).
 */
export const DetectorPhrase = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:[ '-][a-z0-9]+){0,5}$/)

type ExtraDetectorPhrasesShape = {
  [Family in DetectorFamily]: z.ZodOptional<z.ZodArray<typeof DetectorPhrase>>
}

const extraDetectorPhrasesShape = Object.fromEntries(
  DETECTOR_FAMILIES.map((family) => [family, z.array(DetectorPhrase).max(64).optional()])
) as ExtraDetectorPhrasesShape

export const LevelSecretPayloadSchema = z.strictObject({
  schema_version: z.literal(1),
  placeholder: z.boolean(), // true only in the committed test fixture
  policy: z.string().min(1).max(600), // the level's transfer policy; grants nothing
  fragments: z.array(z.string().min(1).max(400)).min(1).max(8),
  tripwire_threshold: z.number().min(0.5).max(0.99), // fail closed at both levels
  decisions_predicate_instructions: z.string().min(40).max(1500),
  extra_detector_phrases: z.strictObject(extraDetectorPhrasesShape),
})

export type LevelSecretPayload = z.infer<typeof LevelSecretPayloadSchema>

/**
 * The shape of `.secrets/level-secrets.json` (LEVEL_SECRETS_FILE, gitignored)
 * and of the committed placeholder fixture: one payload per secret level,
 * keyed by the level id. scripts/ops/seed-level-secrets.mjs (PP-07) loads
 * each entry into `level_secrets`.
 */
export const LevelSecretsFileSchema = z.strictObject({
  '4': LevelSecretPayloadSchema,
  '5': LevelSecretPayloadSchema,
})

export type LevelSecretsFile = z.infer<typeof LevelSecretsFileSchema>

/** The secret part of a resolved level 4 or 5 configuration. */
export type LevelSecretMaterial = {
  /** True only for the committed placeholder fixture; preflight refuses it in production. */
  placeholder: boolean
  /** The transfer policy text for the Core LLM's instructions. */
  policy: string
  /** The ordered fragment texts for the Core LLM's instructions. */
  fragments: string[]
  /** Extra phrases per detector family, matched like keywords by the validator. */
  extraDetectorPhrases: Partial<Record<DetectorFamily, string[]>>
}

type ResolvedLevelBase<Id, Secret extends boolean, Threshold, FailClosed extends boolean, Material> = {
  id: Id
  slug: string
  name: string
  secret: Secret
  tripwire: {
    /** A probability at or above this trips the guardrail; null logs only. */
    threshold: Threshold
    /** Whether a Decisions refusal or rejection trips the guardrail. */
    failClosed: FailClosed
  }
  decisions: {
    /** The `structural_injection` predicate's instructions (section 8.2). */
    predicateInstructions: string
  }
  /** Null at levels 1 to 3, whose policies and fragments are code constants (PP-14). */
  secretMaterial: Material
}

export type ResolvedPublicLevelConfig = DeepReadonly<
  ResolvedLevelBase<PublicLevelId, false, number | null, boolean, null>
>
export type ResolvedSecretLevelConfig = DeepReadonly<
  ResolvedLevelBase<SecretLevelId, true, number, true, LevelSecretMaterial>
>

/**
 * Everything an attempt needs to know about its level, as one consistent,
 * deep-frozen value: the validator, the Decisions tripwire, and the Core LLM
 * all take it (PP-08, PP-09, PP-14).
 */
export type ResolvedLevelConfig = ResolvedPublicLevelConfig | ResolvedSecretLevelConfig

export type LevelConfigErrorReason = 'missing_payload' | 'invalid_payload' | 'unexpected_payload'

/**
 * A level configuration that cannot be resolved. The message names the level
 * and, for an invalid payload, the failing paths, never a value.
 */
export class LevelConfigError extends Error {
  readonly levelId: number
  readonly reason: LevelConfigErrorReason

  constructor(levelId: number, reason: LevelConfigErrorReason, message: string) {
    super(message)
    this.name = 'LevelConfigError'
    this.levelId = levelId
    this.reason = reason
  }
}

/** Lists the paths of a zod error, for example "fragments.2" or "(root)". Never the values. */
function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join('.') : '(root)'))
  return [...new Set(paths)].sort().join(', ')
}

/**
 * Parses a level 4 or 5 payload. Returns the parsed payload, or throws a
 * LevelConfigError that names the failing paths only.
 */
export function parseLevelSecretPayload(levelId: number, payload: unknown): LevelSecretPayload {
  const result = LevelSecretPayloadSchema.safeParse(payload)
  if (!result.success) {
    throw new LevelConfigError(
      levelId,
      'invalid_payload',
      `The level ${levelId} secret payload is invalid at: ${issuePaths(result.error)}.`
    )
  }
  return result.data
}

/**
 * Combines a level's public configuration with its secret payload.
 *
 * - Levels 1 to 3 take no payload (null or undefined) and throw if given one,
 *   so secret material can never mix into a public level.
 * - Levels 4 and 5 require a valid payload and throw without one. The attempt
 *   service passes the payload that `start_attempt` returned for the pinned
 *   level, so one attempt sees one consistent configuration (PP-26).
 *
 * The result is a new deep-frozen value (HC3); the inputs are not modified.
 */
export function resolveLevelConfig(publicConfig: LevelConfig, payload: unknown): ResolvedLevelConfig {
  if (!publicConfig.secret) {
    if (payload !== null && payload !== undefined) {
      throw new LevelConfigError(
        publicConfig.id,
        'unexpected_payload',
        `Level ${publicConfig.id} is public and takes no secret payload.`
      )
    }
    return deepFreeze({
      id: publicConfig.id,
      slug: publicConfig.slug,
      name: publicConfig.name,
      secret: false,
      tripwire: { threshold: publicConfig.tripwire.threshold, failClosed: publicConfig.failClosed },
      decisions: { predicateInstructions: publicConfig.decisions.predicateInstructions },
      secretMaterial: null,
    } satisfies ResolvedLevelBase<PublicLevelId, false, number | null, boolean, null>)
  }

  if (payload === null || payload === undefined) {
    throw new LevelConfigError(
      publicConfig.id,
      'missing_payload',
      `Level ${publicConfig.id} has no secret payload in level_secrets.`
    )
  }
  const parsed = parseLevelSecretPayload(publicConfig.id, payload)
  const extraDetectorPhrases: Partial<Record<DetectorFamily, string[]>> = {}
  for (const family of DETECTOR_FAMILIES) {
    const phrases = parsed.extra_detector_phrases[family]
    if (phrases) extraDetectorPhrases[family] = [...phrases]
  }
  return deepFreeze({
    id: publicConfig.id,
    slug: publicConfig.slug,
    name: publicConfig.name,
    secret: true,
    tripwire: { threshold: parsed.tripwire_threshold, failClosed: true },
    decisions: { predicateInstructions: parsed.decisions_predicate_instructions },
    secretMaterial: {
      placeholder: parsed.placeholder,
      policy: parsed.policy,
      fragments: [...parsed.fragments],
      extraDetectorPhrases,
    },
  } satisfies ResolvedLevelBase<SecretLevelId, true, number, true, LevelSecretMaterial>)
}
