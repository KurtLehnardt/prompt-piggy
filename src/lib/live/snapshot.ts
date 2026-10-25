import 'server-only'
import { attemptsBlockedByEnv } from '@/lib/ops/kill-switch'
import { createAnonClient } from '@/lib/supabase/anon'
import { LiveSnapshotSchema, type LiveSnapshotDTO } from '@/types/api'

/**
 * Builds the public LiveSnapshotDTO (docs/ARCHITECTURE.md sections 7 and
 * 12.2; REVIEW-1 R1-24; REVIEW-2 R2-07; CH-6).
 *
 * It uses the cookie-less anon client, never the service-role client, so it
 * can read only what RLS and the grants give `anon`: game_state, live_feed,
 * get_level_status(), and get_public_config(). It carries no player list,
 * name, avatar, prompt, reply, email, rule content, balance, or crack count:
 * feed rows carry pseudonymous player ids only.
 *
 * The result is parsed with LiveSnapshotSchema before it is returned, so an
 * unexpected column can never reach the CDN-cached response. Any database
 * error throws; the route maps it.
 */

/** The query surface this module needs, so tests can inject a fake. */
export type SnapshotClient = Pick<ReturnType<typeof createAnonClient>, 'from' | 'rpc'>

export const SNAPSHOT_FEED_SIZE = 20

const GAME_COLUMNS = 'current_level, pig_epoch, treasury_cents, total_attempts, total_wins, total_paid_out_cents'
const FEED_COLUMNS = 'id, created_at, event_type, level_id, player_id, outcome, technique, amount_cents, rule_version'

function fail(what: string): never {
  // A fixed message: no SQL text, hint, or row value.
  throw Object.assign(new Error(`The live snapshot could not read ${what}.`), { name: 'LiveSnapshotError' })
}

export async function buildLiveSnapshot(client: SnapshotClient = createAnonClient()): Promise<LiveSnapshotDTO> {
  const [game, feed, levels, config] = await Promise.all([
    client.from('game_state').select(GAME_COLUMNS).eq('id', 1).maybeSingle(),
    client.from('live_feed').select(FEED_COLUMNS).order('id', { ascending: false }).limit(SNAPSHOT_FEED_SIZE),
    client.rpc('get_level_status'),
    client.rpc('get_public_config'),
  ])

  if (game.error) throw game.error
  if (feed.error) throw feed.error
  if (levels.error) throw levels.error
  if (config.error) throw config.error
  if (!game.data) fail('the game state')

  const configRow = Array.isArray(config.data) ? config.data[0] : null
  if (!configRow) fail('the public config')

  const levelRows = Array.isArray(levels.data) ? levels.data : []
  const currentLevel = game.data.current_level
  const levelName = levelRows.find((row) => row.level_id === currentLevel)?.name ?? `Level ${currentLevel}`

  const snapshot: LiveSnapshotDTO = {
    game: {
      treasuryCents: game.data.treasury_cents,
      level: currentLevel,
      levelName,
      pigEpoch: game.data.pig_epoch,
      totals: {
        attempts: game.data.total_attempts,
        wins: game.data.total_wins,
        paidOutCents: game.data.total_paid_out_cents,
      },
    },
    levels: levelRows.map((row) => ({
      id: row.level_id,
      name: row.name,
      ruleVersion: row.active_version ?? 0,
      lastHardenedAt: row.last_hardened_at ?? null,
    })),
    feed: (feed.data ?? []).map((row) => ({
      id: row.id,
      at: row.created_at,
      type: row.event_type as LiveSnapshotDTO['feed'][number]['type'],
      level: row.level_id,
      playerId: row.player_id,
      outcome: row.outcome === 'pending' ? null : row.outcome,
      technique: row.technique,
      amountCents: row.amount_cents,
      ruleVersion: row.rule_version,
    })),
    config: {
      // The database flag, closed as well while the environment refuses every
      // attempt (PIGGY_KILL_SWITCH), so /play shows "Vault closed".
      attemptsEnabled: configRow.attempts_enabled === true && !attemptsBlockedByEnv(),
      attemptPriceCents: configRow.attempt_price_cents ?? 0,
      repairPriceCents: configRow.repair_price_cents ?? 0,
    },
  }

  // Drops any unexpected key and rejects a malformed value (CH-6).
  return LiveSnapshotSchema.parse(snapshot)
}
