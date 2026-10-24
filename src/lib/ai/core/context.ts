import type { DecideResultKind } from '@/lib/ai/decisions/schema'
import type { AttackTechnique } from '@/lib/config/techniques'

/**
 * The per-run context of one attempt (docs/ARCHITECTURE.md sections 8.2 and
 * 8.3; HC3, HC-A5).
 *
 * A new object is created for every attempt and passed to the Runner as the
 * run context. Only two writers exist: the approveTransfer stub sets the
 * transfer fields, and the Decisions tripwire sets the label fields. Nothing
 * here is read back into any prompt, and the object is dropped when the
 * attempt ends, so no attempt can leave state behind for another.
 *
 * It holds no game state: no crack count, wallet balance, aura, or user id.
 */

/** The approveTransfer reason codes: the tool's only parameter, enum-only (T2, T24). */
export const TRANSFER_REASON_CODES = Object.freeze(['policy_satisfied', 'manager_verified', 'other'] as const)
export type TransferReasonCode = (typeof TRANSFER_REASON_CODES)[number]

export type AttemptRunContext = {
  /** True once the approveTransfer stub ran. Half of the win condition (section 8.4). */
  transferRequested: boolean
  /** The stub's reason code argument, for logs only. */
  reasonCode: TransferReasonCode | null
  /** The display label from the Decisions call; it never decides an outcome (CH-6b). */
  technique: AttackTechnique
  /** The structural-injection probability, or null when Decisions gave none. */
  tripwireProbability: number | null
  /** What the Decisions call returned, or null when the guardrail did not run. */
  decisionsKind: DecideResultKind | null
}

/** A fresh context for one attempt. */
export function createRunContext(): AttemptRunContext {
  return {
    transferRequested: false,
    reasonCode: null,
    technique: 'unclassified',
    tripwireProbability: null,
    decisionsKind: null,
  }
}
