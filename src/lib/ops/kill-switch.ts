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
