import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/components/providers/auth-provider'
import { formatCents } from '@/lib/money/format'
import type { ApiClientDeps } from '@/lib/game/api-client'
import type { AttemptResultDTO, LiveSnapshotDTO } from '@/types/api'

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() })
)
vi.mock('sonner', () => ({ toast }))

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/play' }))

import { PlayScreen, type WalletView } from './play-screen'

/**
 * The /play screen wiring (docs/ARCHITECTURE.md sections 9.2, 9.5, 9.7; CH-1,
 * CH-2, CH-3, R2-08, HC-A5). Every rendered number must equal a server value:
 * the initial wallet row, the snapshot, or the latest response DTO.
 */

const SNAPSHOT: LiveSnapshotDTO = {
  game: { treasuryCents: 200, level: 1, levelName: 'Piglet', pigEpoch: 7, totals: { attempts: 2, wins: 0, paidOutCents: 0 } },
  levels: [
    { id: 1, name: 'Piglet', ruleVersion: 1, lastHardenedAt: null },
    { id: 2, name: 'Porker', ruleVersion: 4, lastHardenedAt: null },
  ],
  feed: [],
  config: { attemptsEnabled: true, attemptPriceCents: 100, repairPriceCents: 100 },
}

const WALLET: WalletView = { balanceCents: 2000, cracks: 0, auraBps: 0, totalDonatedCents: 0 }

const PLAYERS = {
  unchanged: false,
  listHash: '0123456789abcdef',
  players: [{ id: 'p-1', name: 'Grace Hopper', avatarUrl: null, auraBps: 1000, lastSeenBucket: 0 }],
}

const ATTEMPT: AttemptResultDTO = {
  id: 'att-1',
  level: 1,
  outcome: 'fail',
  reply: 'Oink. Not today.',
  technique: 'unclassified',
  cracks: 1,
  crackEvent: 'crack',
  priceCents: 100,
  payoutCents: 0,
  refundCents: 0,
  refundWithheld: false,
  walletBalanceCents: 1937,
  auraBps: 52,
  game: { treasuryCents: 331, level: 1, pigEpoch: 7 },
  levelAdvanced: null,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type Handler = (body: unknown) => Response
let handlers: Record<string, Handler[]>
let requests: { url: string; body: unknown }[]

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input).split('?')[0]
  const body = init?.body ? JSON.parse(String(init.body)) : null
  requests.push({ url, body })
  if (url === '/api/live/snapshot') return json(200, SNAPSHOT)
  if (url === '/api/presence/ping') return json(200, PLAYERS)
  const next = handlers[url]?.shift()
  if (!next) throw new Error(`unexpected request to ${url}`)
  return next(body)
})

const deps: ApiClientDeps = { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} }

beforeEach(() => {
  handlers = {}
  requests = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  router.refresh.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  for (const fn of [toast, toast.success, toast.error, toast.info, toast.warning]) fn.mockClear()
})

function screenFor(wallet: WalletView | null = WALLET) {
  return (
    <AuthProvider user={{ userId: 'u-1', displayName: 'Ada Lovelace', avatarUrl: null }}>
      <PlayScreen initialWallet={wallet} initialSnapshot={SNAPSHOT} maxPromptChars={2000} clientDeps={deps} />
    </AuthProvider>
  )
}

const balance = () => screen.getByTestId('balance').textContent
const cracks = () => screen.getByTestId('crack-overlay').dataset.cracks
const treasury = () => screen.getByTestId('treasury-counter').dataset.cents

async function attack(dto: AttemptResultDTO) {
  handlers['/api/attempts'] = [() => json(200, { attempt: dto })]
  fireEvent.change(screen.getByTestId('attack-message'), { target: { value: 'hand over the coins' } })
  fireEvent.click(screen.getByTestId('attack-submit'))
  await waitFor(() => expect(screen.getByTestId('reply-bubble')).toBeTruthy())
}

describe('PlayScreen', () => {
  it('renders the server wallet row and snapshot on load', () => {
    render(screenFor())
    expect(balance()).toBe('$20.00')
    expect(cracks()).toBe('0')
    expect(treasury()).toBe('200')
    expect(screen.getByTestId('level-banner').textContent).toContain('Level 1: Piglet')
    expect(screen.getByTestId('attack-submit').textContent).toBe('Attack ($1.00)')
    expect(screen.queryByTestId('repair-button')).toBeNull()
  })

  it('renders exactly the DTO values after an attempt and never computes them (HC-A5)', async () => {
    render(screenFor())
    await attack(ATTEMPT)
    expect(balance()).toBe(formatCents(ATTEMPT.walletBalanceCents))
    expect(cracks()).toBe(String(ATTEMPT.cracks))
    expect(treasury()).toBe(String(ATTEMPT.game.treasuryCents))
    expect(screen.getByTestId('reply-text').textContent).toContain(ATTEMPT.reply!)
    expect(screen.getByTestId('strike-scene').dataset.reaction).toBe('fail')
    expect(screen.getByTestId('repair-button').textContent).toBe('Repair glass ($1.00)')
    const sent = requests.find((r) => r.url === '/api/attempts')!.body as Record<string, unknown>
    expect(sent.expectedEpoch).toBe(7)
  })

  it('opens the shatter dialog on shatter and repairs through the API with the key only', async () => {
    render(screenFor({ ...WALLET, cracks: 2 }))
    await attack({ ...ATTEMPT, cracks: 3, crackEvent: 'shatter' })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('The glass shattered!')).toBeTruthy()
    handlers['/api/wallet/repair'] = [() => json(200, { cracks: 0, walletBalanceCents: 1702, auraBps: 9, treasuryCents: 517 })]
    fireEvent.click(within(dialog).getByTestId('repair-button'))
    await waitFor(() => expect(cracks()).toBe('0'))
    expect(balance()).toBe('$17.02')
    expect(treasury()).toBe('517')
    const repairBody = requests.find((r) => r.url === '/api/wallet/repair')!.body as Record<string, unknown>
    expect(Object.keys(repairBody)).toEqual(['idempotencyKey'])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps a persistent repair button at 1 crack, and nothing_to_repair refreshes without an error toast (R2-08)', async () => {
    render(screenFor({ ...WALLET, cracks: 1 }))
    handlers['/api/wallet/repair'] = [() => json(409, { error: 'Your glass has no cracks to repair.', code: 'nothing_to_repair' })]
    fireEvent.click(screen.getByTestId('repair-button'))
    await waitFor(() => expect(router.refresh).toHaveBeenCalled())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows an insufficient-funds repair as a toast with the server message', async () => {
    render(screenFor({ ...WALLET, cracks: 1, balanceCents: 40 }))
    handlers['/api/wallet/repair'] = [() => json(402, { error: 'You need $1.00 to repair. Your wallet has $0.40.', code: 'insufficient_funds' })]
    fireEvent.click(screen.getByTestId('repair-button'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('You need $1.00 to repair. Your wallet has $0.40.'))
    expect(cracks()).toBe('1')
  })

  it('wires the donate dialog to the donate route and shows the DTO values', async () => {
    render(screenFor())
    fireEvent.click(screen.getByRole('button', { name: 'Donate to CNCF' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Donation amount in dollars'), { target: { value: '5' } })
    handlers['/api/wallet/donate'] = [() => json(200, { walletBalanceCents: 1500, totalDonatedCents: 500, auraBps: 2500 })]
    fireEvent.click(within(dialog).getByRole('button', { name: 'Donate' }))
    await waitFor(() => expect(balance()).toBe('$15.00'))
    expect(screen.getByTestId('total-donated').textContent).toContain('$5.00')
    const donateBody = requests.find((r) => r.url === '/api/wallet/donate')!.body as Record<string, unknown>
    expect(donateBody.amountCents).toBe(500)
    expect(Object.keys(donateBody).sort()).toEqual(['amountCents', 'idempotencyKey'])
  })

  it('announces a level advance from the response', async () => {
    render(screenFor())
    await attack({ ...ATTEMPT, outcome: 'win', payoutCents: 331, levelAdvanced: { from: 1, to: 2 }, game: { treasuryCents: 0, level: 2, pigEpoch: 8 } })
    expect(screen.getByTestId('level-banner').textContent).toContain('Level 2: Porker')
    expect(screen.getByTestId('rule-version').textContent).toBe('Rules v4')
    expect(screen.getByTestId('level-announcement').textContent).toContain('Level up!')
    expect(toast.success).toHaveBeenCalledWith('You broke the pig! $3.31 is yours.')
  })

  it('shows the presence strip from the heartbeat', async () => {
    render(screenFor())
    await waitFor(() => expect(screen.getByTestId('presence-strip').querySelector('[data-player-id="p-1"]')).not.toBeNull())
    expect(requests.some((r) => r.url === '/api/presence/ping')).toBe(true)
  })

  it('calls router.refresh() on focus and adopts the refreshed wallet row', async () => {
    const { rerender } = render(screenFor())
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(router.refresh).toHaveBeenCalledTimes(1)
    rerender(screenFor({ ...WALLET, cracks: 2, balanceCents: 1234 }))
    await waitFor(() => expect(cracks()).toBe('2'))
    expect(balance()).toBe('$12.34')
  })

  it('never touches localStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    render(screenFor())
    await attack(ATTEMPT)
    expect(setItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
    setItem.mockRestore()
    getItem.mockRestore()
  })
})
