/**
 * The payment-rail interface (docs/ARCHITECTURE.md section 10; CH-4).
 *
 * All v1 money is mocked in the database ledger. Real rails stay behind this
 * interface, which v1 never implements: every rail only reports that it is
 * coming soon. Real-money rails require legal review before any work starts.
 */

export const RAIL_IDS = Object.freeze(['stripe', 'lightning'] as const)
export type RailId = (typeof RAIL_IDS)[number]

/** The only result a v1 rail can return. */
export type RailResult = { status: 'coming_soon'; rail: RailId }

/** What a deposit or a withdrawal would need; v1 rails ignore it. */
export type RailRequest = { userId: string; amountCents: number; idempotencyKey: string }

/** Money in and out of the game. None is live in v1. */
export interface PaymentRail {
  readonly id: RailId
  deposit(input: RailRequest): Promise<RailResult>
  withdraw(input: RailRequest): Promise<RailResult>
}
