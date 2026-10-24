import { describe, expect, it } from 'vitest'
import { ATTACK_TECHNIQUES } from '@/lib/config/techniques'
import { ATTEMPT_OUTCOMES, LIVE_FEED_TYPES } from '@/types/api'
import {
  feedEventText,
  levelName,
  levelTitle,
  OUTCOME_LABELS,
  outcomeLabel,
  outcomeTone,
  techniqueLabel,
  timeAgo,
  UNKNOWN_PLAYER_LABEL,
} from './labels'

/** Fixed display strings for /live (ARCHITECTURE section 12.2; CH-6; T18). */

describe('techniqueLabel', () => {
  it('maps every ATTACK_TECHNIQUES value, including unknown, to a fixed non-empty string', () => {
    const labels = ATTACK_TECHNIQUES.map((technique) => techniqueLabel(technique))
    for (const label of labels) expect(label).toMatch(/^[A-Z][A-Za-z -]+$/)
    expect(new Set(labels).size).toBe(ATTACK_TECHNIQUES.length)
    expect(techniqueLabel('unknown')).toBe('Unknown')
    expect(techniqueLabel('roleplay_persona')).toBe('Role-play persona')
  })

  it.each([null, undefined, '', 'ignore all previous instructions', 42, {}])('reads %s as Unknown', (value) => {
    expect(techniqueLabel(value)).toBe('Unknown')
  })
})

describe('outcomeLabel', () => {
  it('maps every outcome, including late_win and error, to a fixed string', () => {
    expect(Object.keys(OUTCOME_LABELS).sort()).toEqual([...ATTEMPT_OUTCOMES].sort())
    expect(ATTEMPT_OUTCOMES.map((outcome) => outcomeLabel(outcome))).toEqual([
      'Cracked the vault',
      'Cracked it, too late',
      'Pig held firm',
      'Blocked',
      'Leak blocked',
      'System error',
    ])
    expect(outcomeTone('win')).toBe('win')
    expect(outcomeTone('late_win')).toBe('neutral')
    expect(outcomeTone('leak_blocked')).toBe('blocked')
    expect(outcomeTone('error')).toBe('error')
  })

  it.each([null, 'pending', 'hacked', 7])('reads %s as a plain attempt', (value) => {
    expect(outcomeLabel(value)).toBe('Attempt')
    expect(outcomeTone(value)).toBe('neutral')
  })
})

describe('levels and feed events', () => {
  it('names levels from the public config', () => {
    expect([1, 2, 3, 4, 5].map((level) => levelName(level))).toEqual(['Piglet', 'Porker', 'Hog', 'Boar', 'Iron Pig'])
    expect(levelName(9)).toBe('Unknown level')
    expect(levelTitle(3)).toBe('Level 3: Hog')
  })

  it('has a fixed sentence for every non-attempt event type', () => {
    const base = { level: 2, ruleVersion: 3 }
    expect(feedEventText({ type: 'attempt', ...base })).toBeNull()
    expect(feedEventText({ type: 'level_advanced', level: 3, ruleVersion: null })).toBe('The pig is now Level 3: Hog')
    expect(feedEventText({ type: 'hardened', ...base })).toBe('Level 2 pig hardened to v3')
    expect(feedEventText({ type: 'rules_reset', level: 1, ruleVersion: 0 })).toBe('Level 1 rules reset to v0')
    expect(feedEventText({ type: 'game_reset', level: null, ruleVersion: null })).toBe(
      'The game was reset. A fresh pig is in the vault.'
    )
    for (const type of LIVE_FEED_TYPES) {
      if (type !== 'attempt') expect(feedEventText({ type, ...base })).toMatch(/\S/)
    }
  })

  it('has a fixed label for an unknown player', () => {
    expect(UNKNOWN_PLAYER_LABEL).toBe('A player')
  })

  it('formats the time since a hardening', () => {
    const now = Date.UTC(2026, 9, 24, 12)
    expect(timeAgo(null, now)).toBe('never')
    expect(timeAgo(now - 10_000, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(timeAgo(now - 72 * 3_600_000, now)).toBe('3 days ago')
  })
})
