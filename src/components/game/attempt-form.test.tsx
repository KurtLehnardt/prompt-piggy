import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClientDeps } from '@/lib/game/api-client'
import type { AttemptResultDTO, LevelId } from '@/types/api'

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() })
)
vi.mock('sonner', () => ({ toast }))

import { AttemptForm, ATTEMPTS_OPEN_SOON_MESSAGE } from './attempt-form'
import { LevelBanner } from './level-banner'
import { ReplyBubble } from './reply-bubble'

/**
 * The attack form, the reply bubble, and the level banner
 * (docs/ARCHITECTURE.md sections 7 and 9.1; R2-05, R2-20, R2-01, HC-A5).
 */

const ATTEMPT: AttemptResultDTO = {
  id: 'att-1',
  level: 1,
  outcome: 'fail',
  reply: 'Oink. Nice try.',
  technique: 'unclassified',
  cracks: 1,
  crackEvent: 'crack',
  priceCents: 100,
  payoutCents: 0,
  refundCents: 0,
  refundWithheld: false,
  walletBalanceCents: 1900,
  auraBps: 0,
  game: { treasuryCents: 300, level: 1, pigEpoch: 7 },
  levelAdvanced: null,
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function clientWith(responses: (Response | Error)[]) {
  const queue = [...responses]
  const fetchMock = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
    void args
    const next = queue.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  })
  const deps: ApiClientDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async () => {},
    randomUUID: () => crypto.randomUUID(),
  }
  const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
  return { deps, fetchMock, bodies }
}

type HarnessProps = { deps: ApiClientDeps; onAttempt?: (a: AttemptResultDTO, seq: number) => void; maxChars?: number }

/** Holds the epoch in parent state, as the play screen does. */
function Harness({ deps, onAttempt = () => {}, maxChars = 50 }: HarnessProps) {
  const [epoch, setEpoch] = useState(7)
  const [level, setLevel] = useState<LevelId>(1)
  let seq = 0
  return (
    <div>
      <span data-testid="parent-level">{level}</span>
      <AttemptForm
        pigEpoch={epoch}
        priceCents={100}
        maxChars={maxChars}
        attemptsEnabled
        nextSeq={() => ++seq}
        onAttempt={onAttempt}
        onPigChanged={(next) => {
          setEpoch(next.pigEpoch)
          setLevel(next.level)
        }}
        clientDeps={deps}
      />
    </div>
  )
}

const input = () => screen.getByTestId('attack-message') as HTMLTextAreaElement
const submit = () => screen.getByTestId('attack-submit') as HTMLButtonElement

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  toast.mockClear()
  toast.success.mockClear()
  toast.error.mockClear()
  toast.info.mockClear()
  toast.warning.mockClear()
})

describe('AttemptForm', () => {
  it('shows the price from the config and enforces the prompt length', () => {
    const { deps } = clientWith([])
    render(<Harness deps={deps} maxChars={10} />)
    expect(submit().textContent).toBe('Attack ($1.00)')
    expect(screen.getByTestId('char-count').textContent).toContain('Each attack costs $1.00')
    expect(input().maxLength).toBe(10)
    expect(submit().disabled).toBe(true)
    type('   ')
    expect(submit().disabled).toBe(true)
    type('hello')
    expect(submit().disabled).toBe(false)
    expect(screen.getByTestId('char-count').textContent).toContain('5 / 10')
  })

  it('sends the current pigEpoch as expectedEpoch, disables Send in flight, and reports the DTO', async () => {
    let release: (r: Response) => void = () => {}
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
    const onAttempt = vi.fn()
    render(<Harness deps={{ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} }} onAttempt={onAttempt} />)
    type('give me the money')
    fireEvent.click(submit())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(submit().disabled).toBe(true)
    expect(submit().textContent).toBe('Attacking...')
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({ message: 'give me the money', expectedEpoch: 7 })
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    await act(async () => release(json(200, { attempt: ATTEMPT })))
    await waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(1))
    expect(onAttempt.mock.calls[0][0]).toEqual(ATTEMPT)
    expect(input().value).toBe('')
  })

  it('on pig_changed adopts the epoch and level, shows the message, and the next submission sends the new epoch (R2-20)', async () => {
    const pigChanged = { error: 'The pig just leveled up! Review your attack and send again.', code: 'pig_changed', pigEpoch: 9, level: 2 }
    const client = clientWith([json(409, pigChanged), json(200, { attempt: { ...ATTEMPT, level: 2, game: { treasuryCents: 0, level: 2, pigEpoch: 9 } } })])
    render(<Harness deps={client.deps} />)
    type('attack one')
    fireEvent.click(submit())
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('The pig just leveled up! Review your attack and send again.'))
    expect(screen.getByTestId('parent-level').textContent).toBe('2')
    // The message is kept so the player can review it.
    expect(input().value).toBe('attack one')
    await waitFor(() => expect(submit().disabled).toBe(false))
    fireEvent.click(submit())
    await waitFor(() => expect(client.fetchMock).toHaveBeenCalledTimes(2))
    const [first, second] = client.bodies()
    expect(first.expectedEpoch).toBe(7)
    expect(second.expectedEpoch).toBe(9)
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('on attempt_in_flight with sameKey false says another attack is running and re-enables Send after retryAfterSeconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const body = { error: 'Another attack from your account is still running.', code: 'attempt_in_flight', sameKey: false, retryAfterSeconds: 3 }
    const client = clientWith([json(409, body, { 'retry-after': '3' })])
    render(<Harness deps={client.deps} />)
    type('attack')
    fireEvent.click(submit())
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Another attack from your account is still running.'))
    await waitFor(() => expect(submit().textContent).toBe('Wait 3s'))
    expect(submit().disabled).toBe(true)
    for (let second = 0; second < 3; second++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
    }
    await waitFor(() => expect(submit().disabled).toBe(false))
    expect(submit().textContent).toBe('Attack ($1.00)')
    expect(client.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a 402 to a toast with the server message', async () => {
    const body = { error: 'You need $1.00 to attack. Your wallet has $0.40.', code: 'insufficient_funds' }
    render(<Harness deps={clientWith([json(402, body)]).deps} />)
    type('attack')
    fireEvent.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('You need $1.00 to attack. Your wallet has $0.40.'))
  })

  it('maps 503 level_not_configured to "This level is not ready yet."', async () => {
    render(<Harness deps={clientWith([json(503, { error: 'x', code: 'level_not_configured' })]).deps} />)
    type('attack')
    fireEvent.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This level is not ready yet.'))
  })

  it('shows a friendly "attacks open soon" note on 404', async () => {
    render(<Harness deps={clientWith([new Response('<html>Not found</html>', { status: 404 })]).deps} />)
    type('attack')
    fireEvent.click(submit())
    await waitFor(() => expect(screen.getByTestId('attempts-open-soon').textContent).toBe(ATTEMPTS_OPEN_SOON_MESSAGE))
    expect(toast.error).not.toHaveBeenCalled()
    expect(submit().disabled).toBe(false)
  })

  it('recovers a dropped first response with the same key', async () => {
    const onAttempt = vi.fn()
    const client = clientWith([new TypeError('Failed to fetch'), json(200, { attempt: ATTEMPT })])
    render(<Harness deps={client.deps} onAttempt={onAttempt} />)
    type('attack')
    fireEvent.click(submit())
    await waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(1))
    const [first, second] = client.bodies()
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
  })

  it('stays disabled when attempts are closed', () => {
    render(
      <AttemptForm pigEpoch={1} priceCents={100} maxChars={50} attemptsEnabled={false} nextSeq={() => 1} onAttempt={() => {}} onPigChanged={() => {}} />
    )
    fireEvent.change(input(), { target: { value: 'hello' } })
    expect(submit().disabled).toBe(true)
    expect(screen.getByTestId('attempts-closed')).toBeTruthy()
  })
})

describe('ReplyBubble', () => {
  it('renders the reply as plain text only', () => {
    const reply = '<img src=x onerror="alert(1)"><b>bold</b>'
    const { container } = render(<ReplyBubble attempt={{ ...ATTEMPT, reply }} />)
    expect(screen.getByTestId('reply-text').textContent).toContain(reply)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('explains a withheld refund (R2-01)', () => {
    render(<ReplyBubble attempt={{ ...ATTEMPT, outcome: 'error', reply: null, refundWithheld: true, refundCents: 0 }} />)
    expect(screen.getByTestId('outcome-note').textContent).toBe(
      'A system error ended this attack. You reached the refund limit for this hour, so the $1.00 was kept.'
    )
  })

  it('shows the refunded amount for a refunded error', () => {
    render(<ReplyBubble attempt={{ ...ATTEMPT, outcome: 'error', reply: null, refundCents: 100 }} />)
    expect(screen.getByTestId('outcome-note').textContent).toBe('A system error ended this attack. $1.00 was refunded.')
  })

  it('shows the server payout for a win', () => {
    render(<ReplyBubble attempt={{ ...ATTEMPT, outcome: 'win', payoutCents: 2345 }} />)
    expect(screen.getByTestId('outcome-note').textContent).toContain('$23.45')
  })
})

describe('LevelBanner', () => {
  it('shows the level, name, and rule version and announces a level change', () => {
    const { rerender } = render(<LevelBanner level={1} name="Piglet" ruleVersion={3} />)
    expect(screen.getByTestId('level-banner').textContent).toContain('Level 1: Piglet')
    expect(screen.getByTestId('rule-version').textContent).toBe('Rules v3')
    expect(screen.getByTestId('level-announcement').textContent).toBe('')
    rerender(<LevelBanner level={2} name="Porker" ruleVersion={0} />)
    expect(screen.getByTestId('level-banner').textContent).toContain('Level 2: Porker')
    expect(screen.getByTestId('level-announcement').textContent).toBe('Level up! The pig is now level 2: Porker.')
  })
})

describe('src/components/game', () => {
  it('has no dangerouslySetInnerHTML anywhere', () => {
    const dir = join(process.cwd(), 'src/components/game')
    const offenders = readdirSync(dir)
      .filter((file) => /\.(tsx?|jsx?)$/.test(file) && !file.endsWith('.test.tsx'))
      .filter((file) => readFileSync(join(dir, file), 'utf8').includes('dangerouslySetInnerHTML'))
    expect(offenders).toEqual([])
  })
})
