import 'server-only'
import { getEnv } from '@/lib/env'
import { usdToMicros } from '@/lib/ops/spend'

/**
 * Bounded limits for the RPCs and routes (docs/ARCHITECTURE.md sections 9.4,
 * 12.1, and 13; REVIEW-1 R1-09; REVIEW-2 R2-13).
 *
 * src/lib/env.ts parses each variable within the bounds of section 13 and
 * rejects anything outside them, so every value here is in range. Money caps
 * are converted to integer micro-dollars and percentages to basis points
 * before they reach a bigint or integer RPC parameter.
 */

/** The attempt route's `maxDuration` in seconds. */
export const ATTEMPT_MAX_DURATION_S = 30

/** A pending attempt older than this was stranded by a killed function and is reaped (R2-13). */
export const ATTEMPT_STALE_SECONDS = ATTEMPT_MAX_DURATION_S + 15

export type Limits = {
  /** Token bucket capacity for attempts (RATE_LIMIT_BURST). */
  burst: number
  /** Attempt token refill per minute (RATE_LIMIT_ATTEMPTS_PER_MIN). */
  perMin: number
  /** Attempts per user per UTC day (RATE_LIMIT_ATTEMPTS_PER_DAY). */
  perDay: number
  /** Repair and donation refill per minute (RATE_LIMIT_WALLET_PER_MIN). */
  walletPerMin: number
  /** Attempt length cap in characters (MAX_PROMPT_CHARS). */
  maxPromptChars: number
  /** The global daily spend cap in integer micro-dollars (OPENAI_DAILY_SPEND_CAP_USD). */
  dailyCapMicros: number
  /** The attempts' share of the cap in basis points (OPENAI_ATTEMPT_SPEND_SHARE_PCT × 100). */
  attemptShareBps: number
  /** Global hardening jobs per hour (HARDENING_MAX_JOBS_PER_HOUR). */
  jobsPerHour: number
  /** Hardening jobs per winner per hour (HARDENING_MAX_JOBS_PER_USER_PER_HOUR). */
  jobsPerUserPerHour: number
  /** Traffic sample size; 0 disables the traffic filter (HARDENING_TRAFFIC_WINDOW). */
  trafficWindow: number
  /** Traffic share in basis points above which a keyword is dropped (HARDENING_TRAFFIC_MAX_BPS). */
  trafficMaxBps: number
}

/** Reads the limits from the parsed environment. Throws a ServerEnvError for an out-of-range variable. */
export function getLimits(): Limits {
  const env = getEnv()
  return {
    burst: env.RATE_LIMIT_BURST,
    perMin: env.RATE_LIMIT_ATTEMPTS_PER_MIN,
    perDay: env.RATE_LIMIT_ATTEMPTS_PER_DAY,
    walletPerMin: env.RATE_LIMIT_WALLET_PER_MIN,
    maxPromptChars: env.MAX_PROMPT_CHARS,
    dailyCapMicros: usdToMicros(env.OPENAI_DAILY_SPEND_CAP_USD),
    attemptShareBps: env.OPENAI_ATTEMPT_SPEND_SHARE_PCT * 100,
    jobsPerHour: env.HARDENING_MAX_JOBS_PER_HOUR,
    jobsPerUserPerHour: env.HARDENING_MAX_JOBS_PER_USER_PER_HOUR,
    trafficWindow: env.HARDENING_TRAFFIC_WINDOW,
    trafficMaxBps: env.HARDENING_TRAFFIC_MAX_BPS,
  }
}
