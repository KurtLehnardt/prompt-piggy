'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AttemptForm } from '@/components/game/attempt-form'
import { CrackOverlay } from '@/components/game/crack-overlay'
import { LevelBanner } from '@/components/game/level-banner'
import { RepairButton, type RepairOutcome } from '@/components/game/repair-button'
import { ReplyBubble } from '@/components/game/reply-bubble'
import { ShatterDialog } from '@/components/game/shatter-dialog'
import { StrikeScene } from '@/components/game/strike-scene'
import { PresenceStrip } from '@/components/presence/presence-strip'
import { useAuth } from '@/components/providers/auth-provider'
import { TreasuryCounter } from '@/components/treasury/treasury-counter'
import { DonateDialog } from '@/components/wallet/donate-dialog'
import { WalletPanel } from '@/components/wallet/wallet-panel'
import {
  UNREACHABLE_MESSAGE,
  donate,
  errorMessage,
  newIdempotencyKey,
  outcomeMessage,
  repair,
  type ApiClientDeps,
} from '@/lib/game/api-client'
import { clientStateReducer, initialClientState } from '@/lib/game/client-state'
import { useSnapshot } from '@/lib/hooks/use-snapshot'
import { formatCents } from '@/lib/money/format'
import { usePresencePing } from '@/lib/presence/use-presence-ping'
import type { AttemptResultDTO, CrackCount, LevelId, LiveSnapshotDTO } from '@/types/api'

/**
 * The /play client screen (docs/ARCHITECTURE.md sections 9.1, 9.2, 9.5, 9.7;
 * CH-1, CH-2, CH-3, R2-08, HC-A5).
 *
 * Every number shown comes from the server: the wallet row read on load, the
 * public snapshot, or the latest attempt, repair, or donation response. The
 * screen never computes cracks, payouts, refunds, balances, or aura. Each
 * update carries a monotonic sequence number, so a late or duplicate answer
 * never overwrites a newer one. Cracks are never stored in localStorage: on
 * focus or reconnect the screen calls router.refresh(), which reruns the
 * server reads, and adopts the fresh wallet row.
 */
export type WalletView = {
  balanceCents: number
  cracks: CrackCount
  auraBps: number
  totalDonatedCents: number
}

type GameView = { treasuryCents: number; level: number; pigEpoch: number }

export type PlayScreenProps = {
  initialWallet: WalletView | null
  initialSnapshot: LiveSnapshotDTO | null
  maxPromptChars: number
  /** Tests inject fetch, sleep, and the clock for the money calls. */
  clientDeps?: ApiClientDeps
}

/**
 * The CDN may serve a snapshot up to about 7 seconds old (s-maxage 2,
 * stale-while-revalidate 5), so for a moment after one of our own responses
 * a snapshot at the same epoch cannot replace the response's treasury.
 */
const SNAPSHOT_GRACE_MS = 8_000
const REFRESH_THROTTLE_MS = 2_000

const EMPTY_WALLET: WalletView = { balanceCents: 0, cracks: 0, auraBps: 0, totalDonatedCents: 0 }

type WalletState = { seq: number; balanceCents: number; auraBps: number; totalDonatedCents: number }
type WalletAction = { seq: number; balanceCents: number; auraBps: number; totalDonatedCents?: number }

/** Applies a server wallet value unless a newer one (higher seq) is already shown. */
function walletReducer(state: WalletState, action: WalletAction): WalletState {
  if (action.seq <= state.seq) return state
  return {
    seq: action.seq,
    balanceCents: action.balanceCents,
    auraBps: action.auraBps,
    totalDonatedCents: action.totalDonatedCents ?? state.totalDonatedCents,
  }
}

function gameFrom(snapshot: LiveSnapshotDTO | null): GameView | null {
  return snapshot
    ? { treasuryCents: snapshot.game.treasuryCents, level: snapshot.game.level, pigEpoch: snapshot.game.pigEpoch }
    : null
}

export function PlayScreen({ initialWallet, initialSnapshot, maxPromptChars, clientDeps }: PlayScreenProps) {
  const router = useRouter()
  const me = useAuth()
  const start = initialWallet ?? EMPTY_WALLET

  const seqRef = useRef(0)
  const nextSeq = useCallback(() => ++seqRef.current, [])

  const [crack, dispatch] = useReducer(clientStateReducer, start.cracks, initialClientState)
  const [wallet, adoptWallet] = useReducer(walletReducer, {
    seq: 0,
    balanceCents: start.balanceCents,
    auraBps: start.auraBps,
    totalDonatedCents: start.totalDonatedCents,
  })
  const [game, setGame] = useState<GameView | null>(() => gameFrom(initialSnapshot))
  const lastResponseAt = useRef(0)
  const [lastAttempt, setLastAttempt] = useState<AttemptResultDTO | null>(null)
  const [donateOpen, setDonateOpen] = useState(false)
  const donating = useRef(false)

  // The public snapshot: level, epoch, treasury, prices. Epochs only grow.
  const onSnapshot = useCallback((snapshot: LiveSnapshotDTO) => {
    const inGrace = Date.now() - lastResponseAt.current < SNAPSHOT_GRACE_MS
    const next = gameFrom(snapshot)!
    setGame((prev) => {
      if (!prev || next.pigEpoch > prev.pigEpoch) return next
      if (next.pigEpoch === prev.pigEpoch && !inGrace) return { ...prev, treasuryCents: next.treasuryCents }
      return prev
    })
  }, [])
  const { snapshot } = useSnapshot({ initial: initialSnapshot, onSnapshot })

  // The presence strip, fed by the signed-in heartbeat.
  const { players } = usePresencePing()

  // router.refresh() reruns the server reads; adopt the fresh wallet row.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    if (!initialWallet) return
    const seq = nextSeq()
    dispatch({ type: 'attempt', seq, cracks: initialWallet.cracks, crackEvent: 'none' })
    adoptWallet({
      seq,
      balanceCents: initialWallet.balanceCents,
      auraBps: initialWallet.auraBps,
      totalDonatedCents: initialWallet.totalDonatedCents,
    })
  }, [initialWallet, nextSeq])

  // Refresh after a reconnect or when the tab comes back.
  useEffect(() => {
    let last = 0
    const refresh = () => {
      const now = Date.now()
      if (now - last < REFRESH_THROTTLE_MS) return
      last = now
      router.refresh()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router])

  function adoptTreasury(treasuryCents: number) {
    lastResponseAt.current = Date.now()
    setGame((prev) => (prev ? { ...prev, treasuryCents } : prev))
  }

  function handleAttempt(attempt: AttemptResultDTO, seq: number) {
    dispatch({ type: 'attempt', seq, cracks: attempt.cracks, crackEvent: attempt.crackEvent })
    adoptWallet({ seq, balanceCents: attempt.walletBalanceCents, auraBps: attempt.auraBps })
    lastResponseAt.current = Date.now()
    setGame((prev) =>
      !prev || attempt.game.pigEpoch >= prev.pigEpoch
        ? { ...attempt.game }
        : { ...prev, treasuryCents: attempt.game.treasuryCents }
    )
    setLastAttempt(attempt)
    if (attempt.outcome === 'win') toast.success(outcomeMessage(attempt))
  }

  function handlePigChanged(next: { pigEpoch: number; level: LevelId }) {
    if (next.pigEpoch < 1) {
      router.refresh()
      return
    }
    setGame((prev) =>
      prev && next.pigEpoch > prev.pigEpoch ? { ...prev, pigEpoch: next.pigEpoch, level: next.level } : prev
    )
  }

  async function handleRepair(): Promise<RepairOutcome | void> {
    const seq = nextSeq()
    const result = await repair(newIdempotencyKey(clientDeps), clientDeps)
    if (result.kind === 'ok') {
      dispatch({ type: 'repaired', seq })
      adoptWallet({ seq, balanceCents: result.result.walletBalanceCents, auraBps: result.result.auraBps })
      adoptTreasury(result.result.treasuryCents)
      toast.success('Glass repaired.')
      return 'repaired'
    }
    if (result.kind === 'unreachable') {
      toast.error('We lost touch with the server. Reload to see whether the repair went through.')
      return
    }
    // Already repaired, perhaps in another tab: refresh without an error toast.
    if (result.error.code === 'nothing_to_repair' || result.error.code === 'already_finalized') return 'nothing_to_repair'
    toast.error(errorMessage(result))
  }

  async function handleDonate(amountCents: number) {
    if (donating.current) return
    donating.current = true
    const seq = nextSeq()
    try {
      const result = await donate(amountCents, newIdempotencyKey(clientDeps), clientDeps)
      if (result.kind === 'ok') {
        adoptWallet({
          seq,
          balanceCents: result.result.walletBalanceCents,
          auraBps: result.result.auraBps,
          totalDonatedCents: result.result.totalDonatedCents,
        })
        setDonateOpen(false)
        toast.success(`Thank you! You donated ${formatCents(amountCents)} to CNCF. Mock donation: no money moves.`)
      } else if (result.kind === 'unreachable') {
        toast.error(UNREACHABLE_MESSAGE)
      } else {
        toast.error(errorMessage(result))
      }
    } finally {
      donating.current = false
    }
  }

  const levels = snapshot?.levels ?? []
  const level = game?.level ?? snapshot?.game.level ?? 1
  const levelRow = levels.find((row) => row.id === level)
  const levelName = levelRow?.name ?? (snapshot && snapshot.game.level === level ? snapshot.game.levelName : `Level ${level}`)
  const config = snapshot?.config ?? null
  const onStale = () => router.refresh()

  return (
    <div className="flex flex-col gap-6" data-testid="play-screen">
      <LevelBanner level={level} name={levelName} ruleVersion={levelRow?.ruleVersion ?? null} />
      <PresenceStrip players={players} />

      {!initialWallet ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm" data-testid="wallet-missing">
          Your wallet is still being set up. Reload the page in a moment.
        </p>
      ) : null}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex flex-col gap-4">
          <div className="relative min-h-56 overflow-hidden rounded-2xl border bg-card p-4" data-testid="pig-stage">
            <StrikeScene strikeKey={lastAttempt?.id ?? null} outcome={lastAttempt?.outcome ?? null} />
            <CrackOverlay cracks={crack.cracks}>
              {crack.cracks > 0 && config ? (
                <RepairButton cracks={crack.cracks} priceCents={config.repairPriceCents} onRepair={handleRepair} onStale={onStale} />
              ) : null}
            </CrackOverlay>
          </div>

          {lastAttempt ? <ReplyBubble attempt={lastAttempt} /> : null}

          {config && game ? (
            <AttemptForm
              pigEpoch={game.pigEpoch}
              priceCents={config.attemptPriceCents}
              maxChars={maxPromptChars}
              attemptsEnabled={config.attemptsEnabled}
              nextSeq={nextSeq}
              onAttempt={handleAttempt}
              onPigChanged={handlePigChanged}
              onUnauthorized={() => router.refresh()}
              clientDeps={clientDeps}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground" data-testid="game-loading">
              Loading the pig...
            </p>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <div className="rounded-2xl border bg-card p-4 text-2xl">
            {game ? <TreasuryCounter cents={game.treasuryCents} label="Treasury" amountClassName="text-3xl" /> : null}
          </div>
          <div className="rounded-2xl border bg-card p-4">
            <WalletPanel
              name={me.displayName}
              avatarUrl={me.avatarUrl}
              auraBps={wallet.auraBps}
              balanceCents={wallet.balanceCents}
              onDonateClick={() => setDonateOpen(true)}
            />
            <p className="mt-2 text-xs text-muted-foreground" data-testid="total-donated">
              Donated to CNCF (mock): {formatCents(wallet.totalDonatedCents)}
            </p>
          </div>
        </aside>
      </div>

      {config ? (
        <ShatterDialog
          open={crack.shatterOpen}
          onDismiss={() => dispatch({ type: 'dismissShatter' })}
          repairPriceCents={config.repairPriceCents}
          onRepair={handleRepair}
          onStale={onStale}
        />
      ) : null}
      <DonateDialog open={donateOpen} onOpenChange={setDonateOpen} balanceCents={wallet.balanceCents} onDonate={handleDonate} />
    </div>
  )
}
