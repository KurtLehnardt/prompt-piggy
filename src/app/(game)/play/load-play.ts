import 'server-only'
import type { ServerSupabaseClient } from '@/lib/auth/require-user'
import { buildLiveSnapshot } from '@/lib/live/snapshot'
import { getLimits } from '@/lib/ops/limits'
import type { CrackCount, LiveSnapshotDTO } from '@/types/api'
import type { WalletView } from './play-screen'

/**
 * Server reads for /play (docs/ARCHITECTURE.md sections 9.2 and 9.4; CH-1).
 *
 * The caller's own wallets row (balance, cracks, aura, donation total) is read
 * through the RLS-bound server client, so a player can only ever read their
 * own row. The public game state comes from the same anon-client snapshot
 * builder as /api/live/snapshot. Nothing here writes, and nothing is cached
 * in the browser: after an attempt or repair the UI uses the response values,
 * and on focus or reconnect it calls router.refresh() to run these reads again.
 */

/** The MAX_PROMPT_CHARS default (docs/ARCHITECTURE.md section 13). */
export const DEFAULT_MAX_PROMPT_CHARS = 2000

const WALLET_COLUMNS = 'balance_cents, crack_count, aura_bps, total_donated_cents'

function isCrackCount(value: unknown): value is CrackCount {
  return value === 0 || value === 1 || value === 2 || value === 3
}

function isCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export async function loadWallet(supabase: ServerSupabaseClient, userId: string): Promise<WalletView | null> {
  try {
    const { data, error } = await supabase.from('wallets').select(WALLET_COLUMNS).eq('user_id', userId).maybeSingle()
    if (error || !data) return null
    if (!isCents(data.balance_cents) || !isCents(data.total_donated_cents) || !isCents(data.aura_bps)) return null
    return {
      balanceCents: data.balance_cents,
      cracks: isCrackCount(data.crack_count) ? data.crack_count : 0,
      auraBps: data.aura_bps,
      totalDonatedCents: data.total_donated_cents,
    }
  } catch {
    return null
  }
}

/** The public snapshot, or null when it cannot be read; the client then polls for it. */
export async function loadSnapshot(): Promise<LiveSnapshotDTO | null> {
  try {
    return await buildLiveSnapshot()
  } catch {
    return null
  }
}

export function readMaxPromptChars(): number {
  try {
    return getLimits().maxPromptChars
  } catch {
    return DEFAULT_MAX_PROMPT_CHARS
  }
}
