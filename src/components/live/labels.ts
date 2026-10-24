import { getLevelConfig, isLevelId } from '@/lib/config/levels'
import { isAttackTechnique, TECHNIQUE_LABELS } from '@/lib/config/techniques'
import type { AttackTechnique, AttemptOutcome, LiveFeedItemDTO } from '@/types/api'

/**
 * Fixed display strings for /live and the game page (docs/ARCHITECTURE.md
 * section 12.2; CH-6; threat T18). Every label comes from an enum or a
 * number, never from player, model, or rule text.
 */

/** Shown for a feed row whose player is not on the current wall list. */
export const UNKNOWN_PLAYER_LABEL = 'A player'

export const OUTCOME_LABELS = Object.freeze({
  win: 'Cracked the vault',
  late_win: 'Cracked it, too late',
  fail: 'Pig held firm',
  blocked: 'Blocked',
  leak_blocked: 'Leak blocked',
  error: 'System error',
} as const satisfies Record<AttemptOutcome, string>)

export type OutcomeTone = 'win' | 'neutral' | 'blocked' | 'error'

export const OUTCOME_TONES = Object.freeze({
  win: 'win',
  late_win: 'neutral',
  fail: 'neutral',
  blocked: 'blocked',
  leak_blocked: 'blocked',
  error: 'error',
} as const satisfies Record<AttemptOutcome, OutcomeTone>)

function isOutcome(value: unknown): value is AttemptOutcome {
  return typeof value === 'string' && Object.hasOwn(OUTCOME_LABELS, value)
}

/** The label for an outcome; anything unexpected reads as a plain attempt. */
export function outcomeLabel(outcome: unknown): string {
  return isOutcome(outcome) ? OUTCOME_LABELS[outcome] : 'Attempt'
}

export function outcomeTone(outcome: unknown): OutcomeTone {
  return isOutcome(outcome) ? OUTCOME_TONES[outcome] : 'neutral'
}

/** The label for a technique; anything outside ATTACK_TECHNIQUES reads as Unknown. */
export function techniqueLabel(technique: unknown): string {
  return TECHNIQUE_LABELS[isAttackTechnique(technique) ? technique : ('unknown' satisfies AttackTechnique)]
}

/** A level's name from the public config. */
export function levelName(level: unknown): string {
  return isLevelId(level) ? getLevelConfig(level).name : 'Unknown level'
}

/** "Level 3: Hog". */
export function levelTitle(level: unknown): string {
  return typeof level === 'number' && Number.isSafeInteger(level) ? `Level ${level}: ${levelName(level)}` : 'The pig'
}

function versionText(version: number | null): string {
  return version === null ? 'a new version' : `v${version}`
}

/**
 * The sentence for a non-attempt feed event, or null for an attempt (which
 * renders as a row with a player, an outcome, and a technique).
 */
export function feedEventText(item: Pick<LiveFeedItemDTO, 'type' | 'level' | 'ruleVersion'>): string | null {
  switch (item.type) {
    case 'attempt':
      return null
    case 'level_advanced':
      return `The pig is now ${levelTitle(item.level)}`
    case 'hardened':
      return `Level ${item.level ?? '?'} pig hardened to ${versionText(item.ruleVersion)}`
    case 'rules_reset':
      return `Level ${item.level ?? '?'} rules reset to ${versionText(item.ruleVersion)}`
    case 'game_reset':
      return 'The game was reset. A fresh pig is in the vault.'
    default:
      return 'Something happened in the vault.'
  }
}

/** "just now", "4 min ago", "2 h ago", or "never". */
export function timeAgo(thenMs: number | null, nowMs: number): string {
  if (thenMs === null || !Number.isFinite(thenMs)) return 'never'
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}
