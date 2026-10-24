#!/usr/bin/env node
/**
 * The concurrency proof for the attempt, wallet, and reaper RPCs
 * (docs/ARCHITECTURE.md sections 5.1 and 5.4; REVIEW-1 R1-02, REVIEW-2
 * R2-04, R2-05, R2-19; REVIEW-3 R3-06; task PP-22).
 *
 * Usage: pnpm db:concurrency (CI runs it in the db job).
 *
 * It runs only against a LOCAL Supabase stack: NEXT_PUBLIC_SUPABASE_URL must
 * point at localhost or 127.0.0.1, and it uses SUPABASE_SECRET_KEY (or the
 * legacy SUPABASE_SERVICE_ROLE_KEY). It never prints the key, and it refuses
 * any other host, so it can never touch a hosted project.
 *
 * Scenario, against 20 fresh players (each with the $20 starting grant):
 *   1. Parallel starts by one player with different keys: exactly one opens
 *      an attempt and one fee is taken; the others get attempt_in_flight
 *      with sameKey false (no double debit).
 *   2. Stale attempts: two players get an attempt that is moved back past
 *      the reaper threshold, and a third gets a stale attempt whose key is
 *      posted again later (R3-06).
 *   3. One concurrent mix: 200 start_attempt/record_attempt pairs with random
 *      outcomes (at least 50 of them error, a few wins), 10 pairs of
 *      simultaneous start_attempt calls that share one idempotency key, 50
 *      repair_glass calls, 50 donate calls, two reap_stale_attempts calls,
 *      and the same-key re-post of the stale attempt. Starts race repairs
 *      and donations of the same players.
 *   4. 10 simultaneous paid-win records for one epoch.
 *
 * It exits 0 only when it observes zero SQLSTATE 40P01 (deadlock) and zero
 * 23505 (unique violation), no unexpected error, exactly one win per epoch
 * (one win and nine late wins in step 4), no attempt left pending, every
 * crack count within 0..3, attempt_reserved_micros back to 0 on every day,
 * one fee per attempt and one attempt per duplicated key, and the ledger
 * invariants: for every wallet, incoming minus outgoing journal amounts
 * equal the balance; the treasury's journal balance equals the stored
 * treasury; and wallets + treasury + journal balances of player accounts
 * without a wallet equal everything minted minus everything donated.
 */

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const USERS = 20
const PAIRS = 200
const ERRORS = 60
const RANDOM_WINS = 6
const DUPLICATE_KEY_PAIRS = 10
const REPAIRS = 50
const DONATIONS = 50
const REAPER_CALLS = 2
const RACING_WINS = 10
const PARALLEL_SAME_USER = 8

const RESERVE_MICROS = 1000
const DAILY_CAP_MICROS = 1_000_000_000
const ATTEMPT_SHARE_BPS = 8000
const RATE_CAPACITY = 100
const RATE_REFILL_PER_MIN = 600
const DAILY_ATTEMPT_CAP = 1000
const STALE_SECONDS = 45
const REAPER_THRESHOLD_SECONDS = 30
const DEADLINE_MS = 5 * 60 * 1000
const PAGE = 1000

/** True when the URL's host is localhost or 127.0.0.1. */
function isLocalUrl(value) {
  try {
    const { hostname } = new URL(value)
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!isLocalUrl(url)) {
  console.error('NEXT_PUBLIC_SUPABASE_URL must point at a local Supabase stack (localhost or 127.0.0.1).')
  process.exit(2)
}
if (key === '') {
  console.error('SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY) is not set.')
  process.exit(2)
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const stats = {
  calls: {},
  errors: {},
  outcomes: {},
  deadlocks: 0,
  uniqueViolations: 0,
  unexpected: [],
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const jitter = (max) => Math.floor(Math.random() * max)
const pick = (list) => list[Math.floor(Math.random() * list.length)]
const hex64 = () => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64)

function count(bucket, name) {
  bucket[name] = (bucket[name] ?? 0) + 1
}

function tokenOf(error) {
  return (String(error?.message ?? '').match(/^[a-z_]+/) ?? ['?'])[0]
}

function hintOf(error) {
  try {
    return JSON.parse(error?.hint ?? '')
  } catch {
    return null
  }
}

/** Calls an RPC and tallies the result. Never throws for a database error. */
async function rpc(name, args) {
  count(stats.calls, name)
  let result
  try {
    result = await db.rpc(name, args)
  } catch (thrown) {
    stats.unexpected.push(`${name}: ${thrown instanceof Error ? thrown.message : String(thrown)}`)
    return { data: null, error: { code: 'network', message: 'network' } }
  }
  if (result.error) {
    const code = result.error.code ?? 'unknown'
    count(stats.errors, `${name} ${code} ${tokenOf(result.error)}`)
    if (code === '40P01') stats.deadlocks += 1
    if (code === '23505') stats.uniqueViolations += 1
  }
  return result
}

function unexpected(name, error) {
  stats.unexpected.push(`${name}: ${error?.code ?? 'unknown'} ${tokenOf(error)}`)
}

let knownEpoch = 1

async function readGame() {
  const { data, error } = await db.from('game_state').select('pig_epoch, current_level, treasury_cents').eq('id', 1).single()
  if (error) throw new Error(`game_state read failed: ${error.code}`)
  return data
}

function startArgs(userId, idempotencyKey, epoch) {
  return {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_expected_epoch: epoch,
    p_prompt: `pp22 concurrency synthetic prompt ${randomUUID()}`,
    p_prompt_sha256: hex64(),
    p_prompt_fingerprint: hex64(),
    p_reserve_micros: RESERVE_MICROS,
    p_daily_cap_micros: DAILY_CAP_MICROS,
    p_attempt_share_bps: ATTEMPT_SHARE_BPS,
    p_rate_capacity: RATE_CAPACITY,
    p_rate_refill_per_min: RATE_REFILL_PER_MIN,
    p_daily_attempt_cap: DAILY_ATTEMPT_CAP,
    p_stale_seconds: STALE_SECONDS,
  }
}

function recordArgs(attemptId, outcome) {
  const isWin = outcome === 'win'
  return {
    p_attempt_id: attemptId,
    p_outcome: outcome,
    p_reply: outcome === 'blocked' ? null : 'pp22 synthetic reply',
    p_validator_reasons: outcome === 'blocked' ? ['keyword'] : [],
    p_validator_signals: [],
    p_tripwire_probability: Math.random(),
    p_technique: 'unclassified',
    p_canary_leaked: outcome === 'leak_blocked',
    p_tool_called: isWin,
    p_cost_micros: jitter(RESERVE_MICROS + 1),
    p_error_code:
      outcome === 'error'
        ? pick(['upstream_error', 'upstream_timeout', 'upstream_config'])
        : outcome === 'fail' && Math.random() < 0.2
          ? 'incomplete'
          : null,
    p_block_fingerprint: isWin,
    p_user_jobs_per_hour: 3,
  }
}

/**
 * Starts an attempt for the player with one idempotency key, retrying the
 * refusals a real client retries: another attempt in flight, a moved pig,
 * and a rate limit. Returns the attempt row, or null when the player cannot
 * pay.
 */
async function startWithRetry(userId, idempotencyKey) {
  for (let tries = 0; tries < 400; tries += 1) {
    const { data, error } = await rpc('start_attempt', startArgs(userId, idempotencyKey, knownEpoch))
    if (!error) return data[0]
    const token = tokenOf(error)
    if (error.code === 'PT409' && token === 'attempt_in_flight') {
      await sleep(10 + jitter(40))
    } else if (error.code === 'PT409' && token === 'pig_changed') {
      const hint = hintOf(error)
      if (hint && Number.isSafeInteger(hint.pigEpoch)) knownEpoch = Math.max(knownEpoch, hint.pigEpoch)
    } else if (error.code === 'PT429') {
      await sleep(50 + jitter(100))
    } else if (error.code === 'PT402') {
      return null
    } else {
      unexpected('start_attempt', error)
      return null
    }
  }
  stats.unexpected.push('start_attempt: gave up after 400 retries')
  return null
}

async function record(attemptId, outcome) {
  const { data, error } = await rpc('record_attempt', recordArgs(attemptId, outcome))
  if (!error) {
    count(stats.outcomes, data[0].outcome)
    return data[0]
  }
  // A reaper may have finalized it first; the route treats this as success (R2-14).
  if (error.code === 'PT409' && tokenOf(error) === 'already_finalized') return null
  unexpected('record_attempt', error)
  return null
}

async function pairTask(userId, outcome) {
  await sleep(jitter(300))
  const attempt = await startWithRetry(userId, randomUUID())
  if (!attempt) return
  await sleep(jitter(30))
  await record(attempt.attempt_id, outcome)
}

const duplicateKeys = []
let duplicateKeySerialized = 0

/** Two simultaneous starts with one key: one attempt and one fee, never a unique violation. */
async function duplicateKeyTask(userId) {
  const idempotencyKey = randomUUID()
  duplicateKeys.push(idempotencyKey)
  await sleep(jitter(300))
  for (let tries = 0; tries < 400; tries += 1) {
    const results = await Promise.all([
      rpc('start_attempt', startArgs(userId, idempotencyKey, knownEpoch)),
      rpc('start_attempt', startArgs(userId, idempotencyKey, knownEpoch)),
    ])
    const opened = results.filter((r) => !r.error && r.data[0].replay === false)
    const replayed = results.filter((r) => !r.error && r.data[0].replay === true)
    // The other call replays or raises attempt_in_flight: sameKey true when
    // it ran after the first one, sameKey false when another attempt of the
    // same player (from the mix) was still running when it ran.
    const inFlight = results.filter((r) => r.error?.code === 'PT409' && tokenOf(r.error) === 'attempt_in_flight')
    if (opened.length === 1) {
      const id = opened[0].data[0].attempt_id
      if (opened.length + replayed.length + inFlight.length !== 2) {
        stats.unexpected.push('duplicate key: the second call neither replayed nor raised attempt_in_flight')
      }
      if (replayed.length === 1 || inFlight.some((r) => hintOf(r.error)?.sameKey === true)) duplicateKeySerialized += 1
      if (replayed.some((r) => r.data[0].attempt_id !== id)) {
        stats.unexpected.push('duplicate key: a replay returned another attempt')
      }
      await record(id, pick(['fail', 'blocked', 'error']))
      const again = await rpc('start_attempt', startArgs(userId, idempotencyKey, knownEpoch))
      if (again.error || again.data[0].replay !== true || again.data[0].attempt_id !== id) {
        stats.unexpected.push('duplicate key: a re-post after the record did not replay the attempt')
      }
      return
    }
    if (opened.length > 1) {
      stats.unexpected.push('duplicate key: two calls opened an attempt')
      return
    }
    for (const r of results) {
      if (!r.error) continue
      const token = tokenOf(r.error)
      if (r.error.code === 'PT409' && token === 'pig_changed') {
        const hint = hintOf(r.error)
        if (hint && Number.isSafeInteger(hint.pigEpoch)) knownEpoch = Math.max(knownEpoch, hint.pigEpoch)
      } else if (!(r.error.code === 'PT409' && token === 'attempt_in_flight') && r.error.code !== 'PT429') {
        unexpected('start_attempt (duplicate key)', r.error)
        return
      }
    }
    await sleep(10 + jitter(40))
  }
  stats.unexpected.push('duplicate key: gave up after 400 retries')
}

async function repairTask(userId) {
  await sleep(jitter(1500))
  const { error } = await rpc('repair_glass', {
    p_user_id: userId,
    p_idempotency_key: randomUUID(),
    p_rate_capacity: RATE_CAPACITY,
    p_rate_refill_per_min: RATE_REFILL_PER_MIN,
  })
  if (error && !(error.code === 'PT409' && tokenOf(error) === 'nothing_to_repair') && error.code !== 'PT402') {
    unexpected('repair_glass', error)
  }
}

async function donateTask(userId) {
  await sleep(jitter(1500))
  const { error } = await rpc('donate', {
    p_user_id: userId,
    p_amount_cents: 1 + jitter(25),
    p_idempotency_key: randomUUID(),
    p_rate_capacity: RATE_CAPACITY,
    p_rate_refill_per_min: RATE_REFILL_PER_MIN,
  })
  if (error && error.code !== 'PT402') unexpected('donate', error)
}

async function reaperTask(delayMs) {
  await sleep(delayMs)
  const { error } = await rpc('reap_stale_attempts', { p_older_than_seconds: REAPER_THRESHOLD_SECONDS, p_limit: 50 })
  if (error) unexpected('reap_stale_attempts', error)
}

/** Moves an attempt's start back past every staleness threshold (local test data only). */
async function makeStale(attemptId) {
  const createdAt = new Date(Date.now() - 120_000).toISOString()
  const { error } = await db.from('attempts').update({ created_at: createdAt }).eq('id', attemptId)
  if (error) throw new Error(`could not stage a stale attempt: ${error.code}`)
}

async function fetchAll(table, columns, orderColumn) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order(orderColumn)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table} read failed: ${error.code}`)
    rows.push(...data)
    if (data.length < PAGE) return rows
  }
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

async function createPlayers(runId) {
  const ids = await Promise.all(
    Array.from({ length: USERS }, async (_, index) => {
      const { data, error } = await db.auth.admin.createUser({
        email: `pp22-concurrency-${runId}-${index}@example.test`,
        email_confirm: true,
      })
      if (error) throw new Error(`createUser failed: ${error.status ?? ''} ${error.code ?? ''}`)
      return data.user.id
    })
  )
  const { data: wallets, error } = await db.from('wallets').select('user_id, balance_cents').in('user_id', ids)
  if (error) throw new Error(`wallets read failed: ${error.code}`)
  if (wallets.length !== USERS || wallets.some((w) => w.balance_cents <= 0)) {
    throw new Error('the sign-up trigger did not give every player a funded wallet')
  }
  return ids
}

async function main() {
  const started = Date.now()
  const runId = randomUUID().slice(0, 8)
  const checks = []
  const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail })

  const players = await createPlayers(runId)
  knownEpoch = (await readGame()).pig_epoch
  console.log(`Players: ${players.length} (run ${runId}); starting epoch ${knownEpoch}.`)

  // 1. Parallel starts by one player with different keys.
  const solo = players[0]
  const soloBefore = (await db.from('wallets').select('balance_cents').eq('user_id', solo).single()).data.balance_cents
  const burst = await Promise.all(
    Array.from({ length: PARALLEL_SAME_USER }, () => rpc('start_attempt', startArgs(solo, randomUUID(), knownEpoch)))
  )
  const burstOpened = burst.filter((r) => !r.error)
  const burstInFlight = burst.filter(
    (r) => r.error?.code === 'PT409' && tokenOf(r.error) === 'attempt_in_flight' && hintOf(r.error)?.sameKey === false
  )
  const soloAfter = (await db.from('wallets').select('balance_cents').eq('user_id', solo).single()).data.balance_cents
  check(
    `parallel starts by one player: ${PARALLEL_SAME_USER} calls open exactly one attempt and debit once`,
    burstOpened.length === 1 &&
      burstInFlight.length === PARALLEL_SAME_USER - 1 &&
      soloBefore - soloAfter === burstOpened[0]?.data[0].price_cents,
    `opened ${burstOpened.length}, in flight ${burstInFlight.length}, debited ${soloBefore - soloAfter}`
  )
  if (burstOpened.length > 0) await record(burstOpened[0].data[0].attempt_id, 'fail')

  // 2. Stale attempts for the reapers and for the same-key re-post (R3-06).
  const staleOther = []
  for (const userId of [players[18], players[19]]) {
    const attempt = await startWithRetry(userId, randomUUID())
    if (attempt) {
      await makeStale(attempt.attempt_id)
      staleOther.push(attempt.attempt_id)
    }
  }
  const staleKey = randomUUID()
  const staleSame = await startWithRetry(players[17], staleKey)
  if (staleSame) await makeStale(staleSame.attempt_id)

  // 3. The concurrent mix.
  const outcomes = shuffle([
    ...Array(ERRORS).fill('error'),
    ...Array(RANDOM_WINS).fill('win'),
    ...Array.from({ length: PAIRS - ERRORS - RANDOM_WINS }, (_, i) => ['fail', 'blocked', 'leak_blocked'][i % 3]),
  ])
  const tasks = [
    ...outcomes.map((outcome, i) => pairTask(players[i % USERS], outcome)),
    ...Array.from({ length: DUPLICATE_KEY_PAIRS }, (_, i) => duplicateKeyTask(players[i])),
    ...Array.from({ length: REPAIRS }, () => repairTask(pick(players))),
    ...Array.from({ length: DONATIONS }, () => donateTask(pick(players))),
    ...Array.from({ length: REAPER_CALLS }, (_, i) => reaperTask(100 + i * 700)),
    (async () => {
      await sleep(jitter(800))
      const { data, error } = await rpc('start_attempt', startArgs(players[17], staleKey, knownEpoch))
      const replayed = !error && data[0].replay === true && data[0].attempt_id === staleSame?.attempt_id
      check('R3-06: a same-key re-post of a stale attempt replays it after the budgeted settlement', replayed,
        error ? `${error.code} ${tokenOf(error)}` : `replay ${data[0].replay}`)
    })(),
  ]
  const deadline = sleep(DEADLINE_MS).then(() => {
    throw new Error(`the concurrent mix did not finish within ${DEADLINE_MS / 1000} seconds`)
  })
  await Promise.race([Promise.all(tasks), deadline])

  // 4. Simultaneous paid-win records for one epoch.
  const raceEpoch = (await readGame()).pig_epoch
  knownEpoch = raceEpoch
  const racers = []
  for (const userId of players.slice(0, RACING_WINS)) {
    const attempt = await startWithRetry(userId, randomUUID())
    if (attempt) racers.push(attempt)
  }
  const raceResults = await Promise.all(racers.map((a) => record(a.attempt_id, 'win')))
  const raceWins = raceResults.filter((r) => r?.outcome === 'win').length
  const raceLate = raceResults.filter((r) => r?.outcome === 'late_win').length
  const afterRace = await readGame()
  check(
    `${RACING_WINS} simultaneous wins on epoch ${raceEpoch}: exactly one paid win, the rest late_win`,
    racers.length === RACING_WINS &&
      racers.every((a) => a.pig_epoch === raceEpoch) &&
      raceWins === 1 &&
      raceLate === RACING_WINS - 1 &&
      afterRace.pig_epoch === raceEpoch + 1,
    `started ${racers.length}, win ${raceWins}, late_win ${raceLate}, epoch ${raceEpoch} -> ${afterRace.pig_epoch}`
  )

  // Global checks.
  check('zero SQLSTATE 40P01 (deadlock)', stats.deadlocks === 0, `${stats.deadlocks}`)
  check('zero SQLSTATE 23505 (unique violation)', stats.uniqueViolations === 0, `${stats.uniqueViolations}`)
  check('no unexpected error', stats.unexpected.length === 0, stats.unexpected.slice(0, 10).join('; '))
  check(`at least 50 errors recorded`, (stats.outcomes.error ?? 0) >= 50, `${stats.outcomes.error ?? 0}`)

  const attempts = await fetchAll('attempts', 'id, user_id, idempotency_key, outcome, pig_epoch, error_code', 'id')
  const ledger = await fetchAll('ledger_entries', 'id, kind, from_account, to_account, amount_cents, attempt_id', 'id')
  const wallets = await fetchAll('wallets', 'user_id, balance_cents, crack_count', 'user_id')
  const spend = await fetchAll('ai_spend', 'day, attempt_reserved_micros', 'day')
  const game = await readGame()

  const pending = attempts.filter((a) => a.outcome === 'pending')
  check('no attempt left pending', pending.length === 0, `${pending.length} pending`)

  const winEpochs = attempts.filter((a) => a.outcome === 'win').map((a) => a.pig_epoch)
  check('exactly one win per epoch', new Set(winEpochs).size === winEpochs.length, `${winEpochs.length} wins`)

  const stale = attempts.filter((a) => staleOther.includes(a.id) || a.id === staleSame?.attempt_id)
  check(
    'the stale attempts were reaped as error reaped',
    stale.length === staleOther.length + (staleSame ? 1 : 0) &&
      stale.every((a) => a.outcome === 'error' && a.error_code === 'reaped'),
    stale.map((a) => `${a.outcome}/${a.error_code}`).join(',')
  )

  const badCracks = wallets.filter((w) => w.crack_count < 0 || w.crack_count > 3)
  check('every crack count is within 0..3', badCracks.length === 0, `${badCracks.length} out of range`)

  const reserved = spend.filter((s) => Number(s.attempt_reserved_micros) !== 0)
  check('attempt_reserved_micros is back to 0 on every day', reserved.length === 0,
    reserved.map((s) => `${s.day}=${s.attempt_reserved_micros}`).join(','))

  const feesByAttempt = new Map()
  for (const row of ledger) {
    if (row.kind === 'attempt_fee') feesByAttempt.set(row.attempt_id, (feesByAttempt.get(row.attempt_id) ?? 0) + 1)
  }
  const feeProblems = attempts.filter((a) => feesByAttempt.get(a.id) !== 1)
  check('every attempt paid exactly one fee (no double debit)', feeProblems.length === 0, `${feeProblems.length} attempts`)

  const keyProblems = duplicateKeys.filter((k) => attempts.filter((a) => a.idempotency_key === k).length !== 1)
  check(`each of the ${DUPLICATE_KEY_PAIRS} duplicated keys opened exactly one attempt and took one fee`,
    duplicateKeys.length === DUPLICATE_KEY_PAIRS && keyProblems.length === 0,
    `${keyProblems.length} bad keys; ${duplicateKeySerialized} pairs met on the wallet lock (replay or sameKey true)`)

  const net = new Map()
  for (const row of ledger) {
    const amount = Number(row.amount_cents)
    net.set(row.to_account, (net.get(row.to_account) ?? 0) + amount)
    net.set(row.from_account, (net.get(row.from_account) ?? 0) - amount)
  }
  const walletProblems = wallets.filter((w) => (net.get(`player:${w.user_id}`) ?? 0) !== Number(w.balance_cents))
  check('for every wallet, incoming minus outgoing journal amounts equal the balance', walletProblems.length === 0,
    `${walletProblems.length} wallets`)
  check("the treasury's journal balance equals the stored treasury",
    (net.get('treasury') ?? 0) === Number(game.treasury_cents),
    `journal ${net.get('treasury') ?? 0}, stored ${game.treasury_cents}`)

  const walletAccounts = new Set(wallets.map((w) => `player:${w.user_id}`))
  let orphaned = 0
  for (const [account, amount] of net) {
    if (account.startsWith('player:') && !walletAccounts.has(account)) orphaned += amount
  }
  const walletTotal = wallets.reduce((sum, w) => sum + Number(w.balance_cents), 0)
  const minted = ledger.filter((r) => r.from_account === 'mint').reduce((sum, r) => sum + Number(r.amount_cents), 0)
  const donated = ledger.filter((r) => r.to_account === 'cncf').reduce((sum, r) => sum + Number(r.amount_cents), 0)
  check('wallets + treasury + orphaned player accounts = minted - donated',
    walletTotal + Number(game.treasury_cents) + orphaned === minted - donated,
    `${walletTotal} + ${game.treasury_cents} + ${orphaned} vs ${minted} - ${donated}`)

  console.log('\nCalls:', JSON.stringify(stats.calls))
  console.log('Outcomes:', JSON.stringify(stats.outcomes))
  console.log('Refusals and errors:', JSON.stringify(stats.errors))
  console.log(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s\n`)
  for (const { name, pass, detail } of checks) {
    console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
  }
  const failed = checks.filter((c) => !c.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`The concurrency scenario failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
