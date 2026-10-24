import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LiveClosed, LIVE_CLOSED_TEXT } from './live-closed'
import { LiveFeed } from './live-feed'
import { applyFeedToLevels, LevelStatus } from './level-status'
import type { LiveFeedItemDTO, LivePlayerDTO } from '@/types/api'

/** The /live feed, level status, and closed screen (ARCHITECTURE section 12.2; CH-6; T18, T32). */

const KNOWN = '6f1c2e9a-1b2c-4d3e-8f90-123456789abc'
const STRANGER = '7a2d3f0b-2c3d-4e4f-9a01-234567890bcd'

const PLAYERS: LivePlayerDTO[] = [
  { id: KNOWN, name: 'Ada L.', avatarUrl: null, auraBps: 3000, lastSeenBucket: 0 },
]

function item(id: number, extra: Partial<LiveFeedItemDTO> = {}): LiveFeedItemDTO {
  return {
    id,
    at: '2026-10-24T12:00:00Z',
    type: 'attempt',
    level: 1,
    playerId: KNOWN,
    outcome: 'fail',
    technique: 'roleplay_persona',
    amountCents: null,
    ruleVersion: null,
    ...extra,
  }
}

afterEach(() => {
  cleanup()
})

describe('LiveFeed', () => {
  it('resolves playerId through the players list and shows the name, avatar, outcome, and technique', () => {
    render(<LiveFeed feed={[item(1)]} players={PLAYERS} />)
    const row = screen.getByTestId('live-feed').querySelector('[data-feed-type="attempt"]') as HTMLElement
    expect(within(row).getByTestId('feed-player').textContent).toBe('Ada L.')
    expect(within(row).getAllByTestId('avatar-glow')).toHaveLength(1)
    expect(within(row).getByText('Pig held firm')).toBeTruthy()
    expect(within(row).getByText('Role-play persona')).toBeTruthy()
  })

  it.each([
    ['an id that is not on the list', { playerId: STRANGER }],
    ['no id', { playerId: null }],
  ])('shows "A player" with no avatar for %s', (_label, extra) => {
    render(<LiveFeed feed={[item(1, extra)]} players={PLAYERS} />)
    expect(screen.getByTestId('feed-player').textContent).toBe('A player')
    expect(screen.queryByTestId('avatar-glow')).toBeNull()
  })

  it('shows "A player" before the first players list arrives', () => {
    render(<LiveFeed feed={[item(1)]} players={null} />)
    expect(screen.getByTestId('feed-player').textContent).toBe('A player')
  })

  it('shows the payout for a win', () => {
    render(<LiveFeed feed={[item(1, { outcome: 'win', amountCents: 2_550 })]} players={PLAYERS} />)
    expect(screen.getByText('+$25.50')).toBeTruthy()
    expect(screen.getByText('Cracked the vault')).toBeTruthy()
  })

  it('shows no amount for a non-win', () => {
    render(<LiveFeed feed={[item(1, { outcome: 'blocked', amountCents: 100 })]} players={PLAYERS} />)
    expect(screen.queryByText('+$1.00')).toBeNull()
  })

  it('renders level-up and hardening events as fixed sentences', () => {
    render(
      <LiveFeed
        feed={[
          item(3, { type: 'level_advanced', level: 3, playerId: null, outcome: null, technique: null }),
          item(2, { type: 'hardened', level: 2, ruleVersion: 3, playerId: null, outcome: null, technique: null }),
        ]}
        players={PLAYERS}
      />
    )
    expect(screen.getByText('The pig is now Level 3: Hog')).toBeTruthy()
    expect(screen.getByText('Level 2 pig hardened to v3')).toBeTruthy()
  })

  it('says when the feed is empty', () => {
    render(<LiveFeed feed={[]} players={null} />)
    expect(screen.getByText('No attacks yet. Be the first!')).toBeTruthy()
  })
})

describe('LevelStatus and applyFeedToLevels', () => {
  const LEVELS = [
    { id: 1, ruleVersion: 2, lastHardenedAtMs: null },
    { id: 2, ruleVersion: 1, lastHardenedAtMs: null },
  ]

  it('shows the current pig and each level version and last hardening', () => {
    const now = Date.UTC(2026, 9, 24, 12)
    render(
      <LevelStatus
        currentLevel={2}
        levels={[{ id: 1, ruleVersion: 4, lastHardenedAtMs: now - 5 * 60_000 }, LEVELS[1]]}
        nowMs={now}
      />
    )
    expect(screen.getByText('Level 2: Porker')).toBeTruthy()
    expect(screen.getByText('Rules v1')).toBeTruthy()
    expect(screen.getByText('v4 · hardened 5 min ago')).toBeTruthy()
    expect(screen.getByText('v1 · never hardened')).toBeTruthy()
  })

  it('applies hardened and rules_reset events newer than the snapshot, oldest first', () => {
    const feed = [
      item(12, { type: 'rules_reset', level: 2, ruleVersion: 5, at: '2026-10-24T12:02:00Z' }),
      item(11, { type: 'hardened', level: 2, ruleVersion: 4, at: '2026-10-24T12:01:00Z' }),
      item(9, { type: 'hardened', level: 1, ruleVersion: 9 }),
      item(13, { type: 'attempt', level: 1 }),
    ]
    expect(applyFeedToLevels(LEVELS, feed, 10)).toEqual([
      { id: 1, ruleVersion: 2, lastHardenedAtMs: null },
      { id: 2, ruleVersion: 5, lastHardenedAtMs: Date.parse('2026-10-24T12:01:00Z') },
    ])
    expect(LEVELS[1].ruleVersion).toBe(1)
  })
})

describe('LiveClosed', () => {
  it('renders only the projector-link message', () => {
    const { container } = render(<LiveClosed />)
    expect(container.textContent).toBe(LIVE_CLOSED_TEXT)
    expect(LIVE_CLOSED_TEXT).toBe('This screen needs the projector link.')
  })
})
