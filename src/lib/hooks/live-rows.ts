import { getLevelConfig, isLevelId } from '@/lib/config/levels'
import { isAttackTechnique } from '@/lib/config/techniques'
import { ATTEMPT_OUTCOMES, LIVE_FEED_TYPES, type LiveFeedItemDTO, type LiveSnapshotDTO } from '@/types/api'

/**
 * Pure mappers from realtime rows (snake_case, untrusted shape) to the DTOs
 * the /live components take. A row that does not have the expected shape
 * maps to null and is dropped; nothing from it is rendered.
 */

export type LiveGame = LiveSnapshotDTO['game']

/** The feed holds the newest 20 items, like the snapshot. */
export const FEED_SIZE = 20

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?\d{1,16}$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function nullableInt(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null
  const parsed = int(value)
  return parsed === null ? undefined : parsed
}

/** The display name of a level from the public config, never from row text. */
export function levelNameOf(level: number): string {
  return isLevelId(level) ? getLevelConfig(level).name : `Level ${level}`
}

/** game_state UPDATE row -> the snapshot's game block, or null for a malformed row. */
export function gameFromRow(row: Record<string, unknown>): LiveGame | null {
  const level = int(row.current_level)
  const pigEpoch = int(row.pig_epoch)
  const treasuryCents = int(row.treasury_cents)
  const attempts = int(row.total_attempts)
  const wins = int(row.total_wins)
  const paidOutCents = int(row.total_paid_out_cents)
  if (
    level === null ||
    pigEpoch === null ||
    treasuryCents === null ||
    attempts === null ||
    wins === null ||
    paidOutCents === null
  ) {
    return null
  }
  return {
    treasuryCents,
    level,
    levelName: levelNameOf(level),
    pigEpoch,
    totals: { attempts, wins, paidOutCents },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** live_feed INSERT row -> LiveFeedItemDTO, or null for a malformed row. Only enums, numbers, and ids survive. */
export function feedItemFromRow(row: Record<string, unknown>): LiveFeedItemDTO | null {
  const id = int(row.id)
  const at = typeof row.created_at === 'string' && !Number.isNaN(Date.parse(row.created_at)) ? row.created_at : null
  const type = (LIVE_FEED_TYPES as readonly unknown[]).includes(row.event_type)
    ? (row.event_type as LiveFeedItemDTO['type'])
    : null
  const level = nullableInt(row.level_id)
  const amountCents = nullableInt(row.amount_cents)
  const ruleVersion = nullableInt(row.rule_version)
  if (id === null || at === null || type === null) return null
  if (level === undefined || amountCents === undefined || ruleVersion === undefined) return null

  const playerId = typeof row.player_id === 'string' && UUID.test(row.player_id) ? row.player_id : null
  const outcome = (ATTEMPT_OUTCOMES as readonly unknown[]).includes(row.outcome)
    ? (row.outcome as LiveFeedItemDTO['outcome'])
    : null
  const technique = isAttackTechnique(row.technique) ? row.technique : null
  return { id, at, type, level, playerId, outcome, technique, amountCents, ruleVersion }
}

/** Merges new items into the feed: unique by id, newest (highest id) first, at most FEED_SIZE. */
export function mergeFeed(
  incoming: readonly LiveFeedItemDTO[],
  current: readonly LiveFeedItemDTO[]
): LiveFeedItemDTO[] {
  const byId = new Map<number, LiveFeedItemDTO>()
  for (const item of current) byId.set(item.id, item)
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, FEED_SIZE)
}
