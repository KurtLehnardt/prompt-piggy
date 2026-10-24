import type { NextRequest } from 'next/server'
import { jsonError } from '@/lib/errors'
import { DonateRequestSchema, DonateResultSchema, type DonateResultDTO } from '@/types/api'
import { jsonOk, rpcFailure, runWalletRoute } from '../wallet-route'

/**
 * POST /api/wallet/donate (docs/ARCHITECTURE.md sections 7 and 9.5; CH-2,
 * R2-16). The mock CNCF donation: no money moves. Body
 * `{ amountCents, idempotencyKey }` only, with amountCents a positive
 * integer; donate caps it at the stored balance. Answers DonateResultDTO, 422
 * invalid_amount, 402 insufficient_funds, or 429 rate_limited.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROUTE = 'POST /api/wallet/donate'

export async function POST(request: NextRequest) {
  return runWalletRoute(request, DonateRequestSchema, async ({ user, body, admin, rate }) => {
    const { data, error } = await admin.rpc('donate', {
      p_user_id: user.id,
      p_amount_cents: body.amountCents,
      p_idempotency_key: body.idempotencyKey,
      p_rate_capacity: rate.capacity,
      p_rate_refill_per_min: rate.refillPerMin,
    })
    if (error) return rpcFailure(ROUTE, error, 'donate')

    const row = Array.isArray(data) ? data[0] : undefined
    const dto = DonateResultSchema.safeParse(
      row && {
        walletBalanceCents: row.wallet_balance_cents,
        totalDonatedCents: row.total_donated_cents,
        auraBps: row.aura_bps,
      }
    )
    if (!dto.success) {
      console.error(`${ROUTE}: donate returned no usable row`)
      return jsonError('internal', 500)
    }
    return jsonOk<DonateResultDTO>(dto.data)
  })
}
