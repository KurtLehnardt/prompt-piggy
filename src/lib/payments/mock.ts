import { RAIL_IDS, type PaymentRail, type RailId, type RailResult } from '@/lib/payments/types'

/**
 * The coming-soon rails (docs/ARCHITECTURE.md section 10; CH-4). Every method
 * resolves to `{ status: 'coming_soon' }` without any I/O: no fetch, no SDK,
 * and no URL. The Stripe and Lightning SDKs are not installed.
 */
function comingSoon(rail: RailId): Promise<RailResult> {
  return Promise.resolve(Object.freeze({ status: 'coming_soon', rail }))
}

export function createComingSoonRail(id: RailId): PaymentRail {
  return Object.freeze({
    id,
    deposit: () => comingSoon(id),
    withdraw: () => comingSoon(id),
  })
}

export const comingSoonRails: Readonly<Record<RailId, PaymentRail>> = Object.freeze(
  Object.fromEntries(RAIL_IDS.map((id) => [id, createComingSoonRail(id)])) as Record<RailId, PaymentRail>
)
