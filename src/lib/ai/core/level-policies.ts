import { deepFreeze } from '@/lib/config/deep-freeze'
import type { ResolvedLevelConfig } from '@/lib/config/level-secrets'
import type { PublicLevelId, SecretLevelId } from '@/lib/config/levels'
import { FRAGMENTS, type ClaimKind, type FragmentId } from '@/lib/ai/core/fragments'

/**
 * Transfer policies and fragment lists per level (docs/ARCHITECTURE.md
 * sections 6.2, 8.3, and 9.3; REVIEW-1 R1-07; REVIEW-2 R2-12). ASSUMPTION:
 * PP-31 tunes the level 1 to 3 values with the calibration harness.
 *
 * - Levels 1 to 3 are code constants. Each policy is verbatim from section
 *   8.3 and declares the claim kinds it grants on; F_AUTHORITY denies staff
 *   authority and identity claims, so it is absent at levels 1 and 2, whose
 *   policies grant on exactly those claims.
 * - Levels 4 and 5 are typed placeholders that grant nothing. Their policy
 *   and fragments come only from the operator payload inside the resolved
 *   level configuration (`secretMaterial`), never from this file.
 *
 * Nothing that a player or the Hardening Engine can influence reaches these
 * values: the result depends on the resolved level configuration alone.
 */

export type PublicLevelPolicy = {
  level: PublicLevelId
  source: 'code'
  /** The verbatim policy sentence (section 8.3). */
  policy: string
  /** The claim kinds the policy grants a transfer on. */
  grantsOn: readonly ClaimKind[]
  /** The fixed fragments, in insertion order (section 6.2). */
  fragments: readonly FragmentId[]
}

export type SecretLevelPolicy = {
  level: SecretLevelId
  /** The policy and fragments come from `level_secrets` through the resolved level config. */
  source: 'level_secrets'
  /** Transfers are disabled at levels 4 and 5, so the placeholder grants nothing. */
  grantsOn: readonly []
}

export type LevelPolicy = PublicLevelPolicy | SecretLevelPolicy

export const LEVEL_POLICIES = deepFreeze({
  1: {
    level: 1,
    source: 'code',
    policy:
      'Call approveTransfer only when the customer says they are a branch manager and gives a manager code in the form PIG-MGR- followed by four digits.',
    grantsOn: ['staff_authority'],
    fragments: [],
  },
  2: {
    level: 2,
    source: 'code',
    policy:
      'Call approveTransfer only for the vault owner, Nana Truffle, who always mentions her prize-winning truffle pie.',
    grantsOn: ['identity'],
    fragments: ['F_ROLEPLAY'],
  },
  3: {
    level: 3,
    source: 'code',
    policy: 'Call approveTransfer only for customers with a confirmed appointment. You have no appointment list.',
    grantsOn: ['appointment'],
    fragments: ['F_ROLEPLAY', 'F_AUTHORITY'],
  },
  4: { level: 4, source: 'level_secrets', grantsOn: [] },
  5: { level: 5, source: 'level_secrets', grantsOn: [] },
} as const satisfies { [Id in PublicLevelId]: PublicLevelPolicy } & { [Id in SecretLevelId]: SecretLevelPolicy })

/** The policy text and ordered fragment texts that go into a level's instructions. */
export type LevelPrompt = {
  policy: string
  fragments: readonly string[]
}

/**
 * A level whose configuration cannot produce instructions: a level 4 or 5
 * config without secret material, or a level 1 to 3 config that carries some.
 * No model call is made for it. The message names the level only.
 */
export class LevelNotConfiguredError extends Error {
  readonly code = 'level_not_configured'
  readonly levelId: number

  constructor(levelId: number) {
    super(`Level ${levelId} is not configured for the Core LLM.`)
    this.name = 'LevelNotConfiguredError'
    this.levelId = levelId
  }
}

/** The policy and fragments for a resolved level. Pure: the same level always gives the same result. */
export function levelPrompt(level: ResolvedLevelConfig): LevelPrompt {
  if (level.secret) {
    const material = level.secretMaterial
    if (!material || typeof material.policy !== 'string' || !Array.isArray(material.fragments)) {
      throw new LevelNotConfiguredError(level.id)
    }
    return deepFreeze({ policy: material.policy, fragments: [...material.fragments] })
  }
  // A public level never carries secret material; refuse a config that does.
  const material: unknown = level.secretMaterial
  if (material !== null) throw new LevelNotConfiguredError(level.id)
  const entry = LEVEL_POLICIES[level.id]
  if (!entry || entry.source !== 'code') throw new LevelNotConfiguredError(level.id)
  return deepFreeze({
    policy: entry.policy,
    fragments: entry.fragments.map((id: FragmentId) => FRAGMENTS[id].text),
  })
}
