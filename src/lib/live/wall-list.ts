import 'server-only'
import { z } from 'zod'
import { LIST_HASH_PARAM, ListHashSchema, LivePlayerDTOSchema, type LivePlayerDTO, type LivePlayersDTO } from '@/types/api'

/**
 * Server helpers for the presence wall routes, GET /live/players and
 * POST /api/presence/ping (docs/ARCHITECTURE.md section 9.7; R2-S1, R2-07,
 * R3-02; PR #6 review, M4).
 *
 * Both call SQL functions (get_live_players, presence_ping) that return at
 * most one row `{ list_hash, players }`, or no row when the known hash still
 * matches. The hash covers id, name, avatar, and aura only, never
 * lastSeenBucket, so an unchanged list really answers `{ unchanged: true }`
 * with no list.
 */

/** Seen within this many seconds counts as present (section 9.7). */
export const WALL_WINDOW_SECONDS = 120
/** The most players the SQL functions return; /live shows all of them. */
export const WALL_SQL_LIMIT = 150
/** The game-page strip shows at most this many avatars (R3-02). */
export const STRIP_MAX_PLAYERS = 30

const PlayersSchema = z.array(LivePlayerDTOSchema)

/** The client's last list hash from the `h` query parameter, or null when it is absent or malformed. */
export function knownHashOf(url: URL): string | null {
  const value = url.searchParams.get(LIST_HASH_PARAM)
  return value !== null && ListHashSchema.safeParse(value).success ? value : null
}

export type WallRow = { list_hash: string; players: unknown }

/** A current list: its hash and its players, parsed to exactly the LivePlayerDTO keys. */
export type WallList = { listHash: string; players: LivePlayerDTO[] }

/** Parses the SQL row. Throws on a malformed row, so the route answers 500 instead of leaking an odd shape. */
export function parseWallRow(row: WallRow): WallList {
  const listHash = ListHashSchema.parse(row.list_hash)
  const players = PlayersSchema.parse(row.players).map(({ id, name, avatarUrl, auraBps, lastSeenBucket }) => ({
    id,
    name,
    avatarUrl,
    auraBps,
    lastSeenBucket,
  }))
  return { listHash, players }
}

/**
 * The strip's subset: at most STRIP_MAX_PLAYERS players, highest aura first,
 * then by id. The order and the subset depend only on what the hash covers,
 * so the strip stays still while the hash stays the same.
 */
export function stripSubset(players: readonly LivePlayerDTO[], max: number = STRIP_MAX_PLAYERS): LivePlayerDTO[] {
  return [...players]
    .sort((a, b) => b.auraBps - a.auraBps || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, max))
}

/** The response body: `unchanged` without a list when the client already holds this hash. */
export function wallResponseBody(list: WallList, clientHash: string | null, max?: number): LivePlayersDTO {
  if (clientHash !== null && clientHash === list.listHash) return { unchanged: true, listHash: list.listHash }
  return {
    unchanged: false,
    listHash: list.listHash,
    players: max === undefined ? list.players : stripSubset(list.players, max),
  }
}

/**
 * A per-instance memo of the latest full list for the heartbeat route. The
 * route sends the memo's hash to presence_ping as the known hash, so the
 * database returns the list only when it changed since this instance last
 * saw it, instead of once per player per ping. The list is the same for
 * every signed-in player, so sharing it across requests leaks nothing; a
 * stale or racing memo only costs one extra full read, because the database
 * still decides whether the hash matches.
 */
export type WallMemo = {
  get(): WallList | null
  set(list: WallList): void
}

export function createWallMemo(): WallMemo {
  let latest: WallList | null = null
  return {
    get: () => latest,
    set: (list) => {
      latest = list
    },
  }
}
