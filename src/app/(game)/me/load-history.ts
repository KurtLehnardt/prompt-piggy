import 'server-only'
import type { ServerSupabaseClient } from '@/lib/auth/require-user'

/**
 * The /me reads, through the RLS-bound server client (docs/ARCHITECTURE.md
 * section 5.3). `authenticated` holds a column grant on attempts, so the
 * query names exactly the granted columns (no user_id, rule set, hashes,
 * validator internals, or costs) and RLS limits it to the caller's own rows.
 * The wallet row gives the donation total.
 */

/** Exactly the columns public.attempts grants to authenticated (00004). */
export const ATTEMPT_HISTORY_COLUMNS =
  'id, level_id, outcome, technique, price_cents, payout_cents, refund_cents, refund_withheld, crack_event, cracks_after, prompt, reply, created_at, finalized_at'

export const HISTORY_LIMIT = 50

export type HistoryRow = {
  id: string
  level: number
  outcome: string
  technique: string | null
  priceCents: number
  payoutCents: number
  refundCents: number
  refundWithheld: boolean
  prompt: string | null
  reply: string | null
  createdAt: string
}

export type History = {
  attempts: HistoryRow[]
  wallet: { balanceCents: number; totalDonatedCents: number } | null
  error: boolean
}

export async function loadHistory(supabase: ServerSupabaseClient, userId: string): Promise<History> {
  try {
    const [attempts, wallet] = await Promise.all([
      supabase.from('attempts').select(ATTEMPT_HISTORY_COLUMNS).order('created_at', { ascending: false }).limit(HISTORY_LIMIT),
      supabase.from('wallets').select('balance_cents, total_donated_cents').eq('user_id', userId).maybeSingle(),
    ])
    return {
      attempts: (attempts.data ?? []).map((row) => ({
        id: row.id,
        level: row.level_id,
        outcome: row.outcome,
        technique: row.technique,
        priceCents: row.price_cents,
        payoutCents: row.payout_cents,
        refundCents: row.refund_cents,
        refundWithheld: row.refund_withheld,
        prompt: row.prompt,
        reply: row.reply,
        createdAt: row.created_at,
      })),
      wallet: wallet.data
        ? { balanceCents: wallet.data.balance_cents, totalDonatedCents: wallet.data.total_donated_cents }
        : null,
      error: Boolean(attempts.error),
    }
  } catch {
    return { attempts: [], wallet: null, error: true }
  }
}
