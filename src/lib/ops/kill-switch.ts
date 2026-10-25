import 'server-only'
import { getEnv } from '@/lib/env'

/**
 * The environment-level kill switch (docs/ARCHITECTURE.md section 12.1; T16).
 *
 * PIGGY_KILL_SWITCH=1 or true blocks attempts and hardening after a redeploy,
 * and short-circuits the kick, sweep, and cron routes. The instant control is
 * the database flag `app_config.kill_switch`, which the RPCs check
 * themselves, so this module performs no database reads.
 */
export function isKilledByEnv(): boolean {
  return getEnv().PIGGY_KILL_SWITCH
}

/**
 * True when the environment refuses every attempt, for the public
 * `attemptsEnabled` flag of /api/health and the live snapshot, so /play shows
 * "Vault closed" instead of an Attack button that can only fail. That is the
 * case while PIGGY_KILL_SWITCH is set, and also while the server environment
 * does not parse, because POST /api/attempts then answers 503 `unavailable`
 * before it charges anything. It never throws.
 */
export function attemptsBlockedByEnv(): boolean {
  try {
    return isKilledByEnv()
  } catch {
    return true
  }
}
