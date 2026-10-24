import 'server-only'
import { getEnv, ServerEnvError } from '@/lib/env'
import { comingSoonRails } from '@/lib/payments/mock'
import type { PaymentRail, RailId } from '@/lib/payments/types'

/**
 * The payment-rail factory (docs/ARCHITECTURE.md section 10; CH-4). Only
 * PAYMENTS_MODE=mock exists in v1; any other mode throws before a rail is
 * returned. The UI never imports this module: the wallet panel's buttons only
 * show a "Coming soon" toast.
 */
export type { PaymentRail, RailId, RailResult, RailRequest } from '@/lib/payments/types'

export const PAYMENTS_MODE_ERROR =
  'Only PAYMENTS_MODE=mock is allowed in v1. Real-money rails require legal review first.'

function paymentsMode(): string {
  try {
    return getEnv().PAYMENTS_MODE
  } catch (error) {
    // env.ts accepts only the literal 'mock', so any other value lands here.
    if (error instanceof ServerEnvError && error.names.includes('PAYMENTS_MODE')) {
      throw new Error(PAYMENTS_MODE_ERROR)
    }
    throw error
  }
}

export function getPaymentRail(id: RailId): PaymentRail {
  if (paymentsMode() !== 'mock') {
    throw new Error(PAYMENTS_MODE_ERROR)
  }
  const rail = comingSoonRails[id]
  if (!rail) throw new RangeError('Unknown payment rail.')
  return rail
}
