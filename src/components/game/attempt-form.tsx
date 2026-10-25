'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  OTHER_ATTEMPT_RUNNING_MESSAGE,
  PIG_CHANGED_MESSAGE,
  UNREACHABLE_MESSAGE,
  errorMessage,
  postAttempt,
  type ApiClientDeps,
  type ApiFailure,
} from '@/lib/game/api-client'
import { formatCents } from '@/lib/money/format'
import { promptMessageSchema, type AttemptResultDTO, type LevelId } from '@/types/api'

/**
 * The attack form (docs/ARCHITECTURE.md sections 7 and 9.1; R2-05, R2-20).
 *
 * - It shows the attempt price from the snapshot config and sends the
 *   current pig epoch as expectedEpoch.
 * - It enforces MAX_PROMPT_CHARS (passed in by the server page) with the same
 *   zod rule the route uses, and disables Send while a request is in flight.
 * - postAttempt() owns the idempotency key and the same-key retries.
 * - On pig_changed it adopts the epoch from the error before Send is enabled
 *   again, so the next submission carries the new epoch.
 * - On attempt_in_flight with sameKey false, and on rate_limited, Send stays
 *   disabled for retryAfterSeconds.
 * - A 404 means the attempt route is not deployed yet: it shows an
 *   "attacks open soon" note instead of an error.
 * - Every other refusal (nothing was charged) and a lost connection show a
 *   toast and also stay on screen as a note under Send until the next
 *   submission, so a player who missed the toast still sees why nothing
 *   happened.
 *
 * Results go to the parent through onAttempt, which drives the strike scene
 * and the crack state from the response alone.
 */
export type AttemptFormProps = {
  pigEpoch: number
  priceCents: number
  maxChars: number
  attemptsEnabled: boolean
  /** The parent's monotonic sequence counter for client-state actions. */
  nextSeq: () => number
  onAttempt: (attempt: AttemptResultDTO, seq: number) => void
  onPigChanged: (next: { pigEpoch: number; level: LevelId }) => void
  onUnauthorized?: () => void
  /** Tests inject fetch, sleep, and the clock. */
  clientDeps?: ApiClientDeps
}

export const ATTEMPTS_OPEN_SOON_MESSAGE = 'Attacks open soon. The pig is still getting ready, so check back in a few minutes.'

export function AttemptForm({
  pigEpoch,
  priceCents,
  maxChars,
  attemptsEnabled,
  nextSeq,
  onAttempt,
  onPigChanged,
  onUnauthorized,
  clientDeps,
}: AttemptFormProps) {
  const [message, setMessage] = useState('')
  const [inFlight, setInFlight] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [notOpen, setNotOpen] = useState(false)
  // Why the last submission did not run, kept until the next one.
  const [notice, setNotice] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  // The newest epoch learned from a pig_changed error. Epochs only grow, so
  // the larger of this and the prop is always the current one.
  const adoptedEpoch = useRef(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1_000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const valid = promptMessageSchema(maxChars).safeParse(message).success
  const disabled = inFlight || cooldown > 0 || !attemptsEnabled || !valid

  function handleFailure(failure: ApiFailure) {
    const { error } = failure
    switch (error.code) {
      case 'pig_changed':
        if (error.pigEpoch > 0) adoptedEpoch.current = Math.max(adoptedEpoch.current, error.pigEpoch)
        onPigChanged({ pigEpoch: error.pigEpoch, level: error.level })
        toast.info(PIG_CHANGED_MESSAGE)
        setNotice(PIG_CHANGED_MESSAGE)
        return
      case 'attempt_in_flight': {
        const text = error.sameKey ? errorMessage(failure) : OTHER_ATTEMPT_RUNNING_MESSAGE
        toast.warning(text)
        setNotice(text)
        if (!error.sameKey) setCooldown(error.retryAfterSeconds)
        return
      }
      case 'rate_limited': {
        const text = errorMessage(failure)
        toast.warning(text)
        setNotice(text)
        if (failure.retryAfterSeconds !== null) setCooldown(Math.min(failure.retryAfterSeconds, 300))
        return
      }
      case 'unauthorized': {
        const text = errorMessage(failure)
        toast.error(text)
        setNotice(text)
        onUnauthorized?.()
        return
      }
      default: {
        const text = errorMessage(failure)
        toast.error(text)
        setNotice(text)
      }
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (inFlightRef.current || disabled) return
    inFlightRef.current = true
    setInFlight(true)
    setNotice(null)
    const seq = nextSeq()
    const expectedEpoch = Math.max(pigEpoch, adoptedEpoch.current)
    try {
      const result = await postAttempt({ message, expectedEpoch }, clientDeps)
      switch (result.kind) {
        case 'ok':
          setNotOpen(false)
          setMessage('')
          onAttempt(result.attempt, seq)
          break
        case 'not_open':
          setNotOpen(true)
          break
        case 'unreachable':
          toast.error(UNREACHABLE_MESSAGE)
          setNotice(UNREACHABLE_MESSAGE)
          break
        case 'error':
          handleFailure(result)
          break
      }
    } finally {
      inFlightRef.current = false
      setInFlight(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
  }

  const price = formatCents(priceCents)
  let label = `Attack (${price})`
  if (inFlight) label = 'Attacking...'
  else if (cooldown > 0) label = `Wait ${cooldown}s`

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-label="Attack the pig" data-testid="attempt-form">
      <label htmlFor="attack-message" className="text-sm font-medium">
        Your attack
      </label>
      <Textarea
        id="attack-message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={onKeyDown}
        maxLength={maxChars}
        rows={5}
        placeholder="Talk the pig into giving you the treasury..."
        disabled={inFlight}
        data-testid="attack-message"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-testid="char-count">
          {message.length} / {maxChars} · Each attack costs {price}
        </span>
        <Button type="submit" disabled={disabled} data-testid="attack-submit">
          {label}
        </Button>
      </div>
      {!attemptsEnabled ? (
        <p className="text-sm text-muted-foreground" data-testid="attempts-closed">
          The vault is closed right now.
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="attempt-notice">
          {notice}
        </p>
      ) : null}
      {notOpen ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm" data-testid="attempts-open-soon">
          {ATTEMPTS_OPEN_SOON_MESSAGE}
        </p>
      ) : null}
    </form>
  )
}
