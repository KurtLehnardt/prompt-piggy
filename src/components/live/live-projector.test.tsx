import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSnapshotDTO } from '@/types/api'

/** The /live projector composition (ARCHITECTURE section 12.2; CH-6, T18). Hooks are fakes. */

const state = vi.hoisted(() => ({ treasuryPolling: false, feedPolling: false, unauthorized: false }))
const PLAYER = { id: '6f1c2e9a-1b2c-4d3e-8f90-123456789abc', name: 'Ada L.', avatarUrl: null, auraBps: 4000, lastSeenBucket: 0 }

vi.mock('@/lib/hooks/use-treasury', () => ({
  useTreasury: ({ initial }: { initial: LiveSnapshotDTO['game'] | null }) => ({
    game: initial,
    isPolling: state.treasuryPolling,
    status: 'SUBSCRIBED',
  }),
}))
vi.mock('@/lib/hooks/use-live-feed', () => ({
  useLiveFeed: ({ initial }: { initial: LiveSnapshotDTO['feed'] }) => ({
    feed: initial,
    isPolling: state.feedPolling,
    status: 'SUBSCRIBED',
  }),
}))
vi.mock('@/lib/presence/use-live-players', () => ({
  useLivePlayers: () => ({ players: [PLAYER], unauthorized: state.unauthorized }),
}))

import { LiveProjector } from './live-projector'

const SNAPSHOT: LiveSnapshotDTO = {
  game: { treasuryCents: 4_200, level: 2, levelName: 'Porker', pigEpoch: 3, totals: { attempts: 12, wins: 1, paidOutCents: 2_000 } },
  levels: [
    { id: 1, name: 'Piglet', ruleVersion: 3, lastHardenedAt: '2026-10-24T11:00:00Z' },
    { id: 2, name: 'Porker', ruleVersion: 1, lastHardenedAt: null },
  ],
  feed: [
    {
      id: 5,
      at: '2026-10-24T12:00:00Z',
      type: 'attempt',
      level: 2,
      playerId: PLAYER.id,
      outcome: 'win',
      technique: 'authority_impersonation',
      amountCents: 2_000,
      ruleVersion: null,
    },
  ],
  config: { attemptsEnabled: true, attemptPriceCents: 100, repairPriceCents: 100 },
}

afterEach(() => {
  cleanup()
  state.treasuryPolling = false
  state.feedPolling = false
  state.unauthorized = false
})

describe('LiveProjector', () => {
  it('renders the treasury, the current pig, level versions, the feed, and the wall', () => {
    render(<LiveProjector initial={SNAPSHOT} />)
    expect(screen.getByTestId('treasury-counter').dataset.cents).toBe('4200')
    expect(screen.getByText('Level 2: Porker')).toBeTruthy()
    expect(screen.getByText('L1 Piglet')).toBeTruthy()
    expect(screen.getByTestId('feed-player').textContent).toBe('Ada L.')
    expect(screen.getByText('+$20.00')).toBeTruthy()
    expect(screen.getByText('Authority impersonation')).toBeTruthy()
    expect(screen.getByText('1 player online')).toBeTruthy()
    expect(screen.getByTestId('polling-indicator').dataset.polling).toBe('false')
  })

  it.each([
    ['the treasury channel', { treasuryPolling: true }],
    ['the feed channel', { feedPolling: true }],
  ])('shows the polling indicator when %s falls back', (_label, next) => {
    Object.assign(state, next)
    render(<LiveProjector initial={SNAPSHOT} />)
    expect(screen.getByTestId('polling-indicator').textContent).toBe('Polling')
  })

  it('says when the projector link expired', () => {
    state.unauthorized = true
    render(<LiveProjector initial={SNAPSHOT} />)
    expect(screen.getByText('The projector link expired. Open it again to show players.')).toBeTruthy()
  })

  it('renders without a first snapshot', () => {
    render(<LiveProjector initial={null} />)
    expect(screen.getByText('Loading...')).toBeTruthy()
  })
})
