import type { NextRequest } from 'next/server'
import { jsonError } from '@/lib/errors'
import { RepairRequestSchema, RepairResultSchema, type RepairResultDTO } from '@/types/api'
import { jsonOk, rpcFailure, runWalletRoute } from '../wallet-route'

/**
 * POST /api/wallet/repair (docs/ARCHITECTURE.md sections 7 and 9.2; CH-1,
 * R2-08, R2-16). Body `{ idempotencyKey }` only: the price comes from
 * app_config inside repair_glass and is never sent. Answers RepairResultDTO,
 * 409 nothing_to_repair at 0 cracks (nothing is charged), 402
 * insufficient_funds with the balance and the price, or 429 rate_limited.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROUTE = 'POST /api/wallet/repair'

export async function POST(request: NextRequest) {
  return runWalletRoute(request, RepairRequestSchema, async ({ user, body, admin, rate }) => {
    const { data, error } = await admin.rpc('repair_glass', {
      p_user_id: user.id,
      p_idempotency_key: body.idempotencyKey,
      p_rate_capacity: rate.capacity,
      p_rate_refill_per_min: rate.refillPerMin,
    })
    if (error) return rpcFailure(ROUTE, error, 'repair')

    const row = Array.isArray(data) ? data[0] : undefined
    if (!row) {
      console.error(`${ROUTE}: repair_glass returned no row`)
      return jsonError('internal', 500)
    }
    // A replayed key whose glass has cracked again since: the repair already
    // went through, so nothing is charged and the client refreshes.
    if (row.replay && row.cracks !== 0) {
      return jsonError('already_finalized', 409, 'This repair already went through.')
    }
    const dto = RepairResultSchema.safeParse({
      cracks: row.cracks,
      walletBalanceCents: row.wallet_balance_cents,
      auraBps: row.aura_bps,
      treasuryCents: row.treasury_cents,
    })
    if (!dto.success) {
      console.error(`${ROUTE}: repair_glass returned an unexpected row`)
      return jsonError('internal', 500)
    }
    return jsonOk<RepairResultDTO>(dto.data)
  })
}
