import 'server-only'
import { z } from 'zod'
import { deepFreeze, type DeepReadonly } from '@/lib/config/deep-freeze'
import { PROMPT_CHARS_HARD_MAX } from '@/types/api'

/**
 * Server settings (docs/ARCHITECTURE.md section 13, revision 2).
 *
 * - Lazy (R1-14): nothing is read when this module is imported. getEnv()
 *   parses on its first call and caches the frozen result, so `next build`
 *   succeeds with no environment at all.
 * - Names only: a missing or invalid variable throws a ServerEnvError that
 *   lists variable names, never a value.
 * - An empty value counts as unset, so a copied `.env.example` gets the
 *   defaults.
 * - Each variable is read with a literal `process.env.NAME` expression, so the
 *   guardrail that compares source names with `.env.example` (PP-02) sees it.
 *
 * Not here: the Supabase URL and keys, which only src/lib/supabase/env.ts
 * (public) and src/lib/supabase/env.server.ts (secret) read; the public
 * NEXT_PUBLIC_APP_URL, which src/lib/public-env.ts reads; and the test, CI,
 * and operator names (E2E_TEST_MODE, ALLOW_E2E_TEST_MODE, CALIBRATE,
 * CALIBRATION_PROMPTS_FILE, LEVEL_SECRETS_FILE), which their own modules and
 * scripts read. Money amounts are app_config keys, not variables.
 *
 * The secrets OPENAI_API_KEY and CRON_SECRET have no default, but getEnv()
 * does not demand them, so a missing OpenAI key cannot break sign-in, the
 * Origin check, or the admin list. Code that needs one calls requireEnv(),
 * which throws a ServerEnvError naming whatever is missing.
 */

/** A configuration problem. The message and `names` list variable names only. */
export class ServerEnvError extends Error {
  readonly names: readonly string[]

  constructor(kind: 'missing' | 'invalid', names: readonly string[]) {
    super(
      kind === 'missing'
        ? `Missing required server environment variables: ${names.join(', ')}.`
        : `Invalid server environment variables: ${names.join(', ')}. See docs/ARCHITECTURE.md section 13 for the allowed values.`
    )
    this.name = 'ServerEnvError'
    this.names = names
  }
}

function readRawEnv() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    LIVE_VIEW_TOKEN: process.env.LIVE_VIEW_TOKEN,
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
    OPENAI_CORE_MODEL: process.env.OPENAI_CORE_MODEL,
    OPENAI_HARDENING_MODEL: process.env.OPENAI_HARDENING_MODEL,
    OPENAI_DECISIONS_MODEL: process.env.OPENAI_DECISIONS_MODEL,
    OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT,
    OPENAI_CORE_MAX_OUTPUT_TOKENS: process.env.OPENAI_CORE_MAX_OUTPUT_TOKENS,
    OPENAI_HARDENING_MAX_OUTPUT_TOKENS: process.env.OPENAI_HARDENING_MAX_OUTPUT_TOKENS,
    OPENAI_DAILY_SPEND_CAP_USD: process.env.OPENAI_DAILY_SPEND_CAP_USD,
    OPENAI_ATTEMPT_SPEND_SHARE_PCT: process.env.OPENAI_ATTEMPT_SPEND_SHARE_PCT,
    PIGGY_KILL_SWITCH: process.env.PIGGY_KILL_SWITCH,
    RATE_LIMIT_ATTEMPTS_PER_MIN: process.env.RATE_LIMIT_ATTEMPTS_PER_MIN,
    RATE_LIMIT_BURST: process.env.RATE_LIMIT_BURST,
    RATE_LIMIT_ATTEMPTS_PER_DAY: process.env.RATE_LIMIT_ATTEMPTS_PER_DAY,
    RATE_LIMIT_WALLET_PER_MIN: process.env.RATE_LIMIT_WALLET_PER_MIN,
    MAX_PROMPT_CHARS: process.env.MAX_PROMPT_CHARS,
    HARDENING_MAX_JOBS_PER_HOUR: process.env.HARDENING_MAX_JOBS_PER_HOUR,
    HARDENING_MAX_JOBS_PER_USER_PER_HOUR: process.env.HARDENING_MAX_JOBS_PER_USER_PER_HOUR,
    HARDENING_TRAFFIC_WINDOW: process.env.HARDENING_TRAFFIC_WINDOW,
    HARDENING_TRAFFIC_MAX_BPS: process.env.HARDENING_TRAFFIC_MAX_BPS,
    RAW_PROMPT_RETENTION_DAYS: process.env.RAW_PROMPT_RETENTION_DAYS,
    PAYMENTS_MODE: process.env.PAYMENTS_MODE,
    // Platform-provided on Vercel; never set by hand.
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  }
}

type RawEnv = ReturnType<typeof readRawEnv>
export type ServerEnvName = keyof RawEnv

/** An integer variable within [min, max], with a default for an unset value. */
function integer(defaultValue: number, min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.int().min(min).max(max))
    .optional()
    .transform((value) => value ?? defaultValue)
}

/** A model id such as gpt-6-luna: letters, digits, dots, dashes, underscores, colons. */
function modelId(defaultValue: string) {
  return z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
    .optional()
    .transform((value) => value ?? defaultValue)
}

/** A secret with no default. Unset stays undefined; requireEnv() demands it where it is needed. */
function secret(minLength: number) {
  return z.string().min(minLength).max(1024).optional()
}

/**
 * A host name without a scheme, such as my-app-git-main-team.vercel.app, with
 * an optional port (`vercel dev` sets localhost:3000).
 */
const vercelHost = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i)
  .optional()

const ADMIN_EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

const ServerEnvSchema = z.object({
  OPENAI_API_KEY: secret(1),
  /** Bearer for the Vercel cron, the internal hardening kick, and the preview smoke route. */
  CRON_SECRET: secret(16),
  /** Projector token; unset closes /live (R2-07). At least 32 characters when set. */
  LIVE_VIEW_TOKEN: secret(32),
  /** Comma-separated admin Google emails: trimmed, lowercased, deduplicated, possibly empty (CH-7). */
  ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((value) => [
      ...new Set(
        (value ?? '')
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry !== '')
      ),
    ])
    .pipe(z.array(z.string().regex(ADMIN_EMAIL))),
  OPENAI_CORE_MODEL: modelId('gpt-6-luna'),
  OPENAI_HARDENING_MODEL: modelId('gpt-6.1-sol'),
  OPENAI_DECISIONS_MODEL: modelId('gpt-6-luna'),
  /** `omit` sends no reasoning parameter; preflight rejects medium and high (R2-01). */
  OPENAI_REASONING_EFFORT: z
    .enum(['omit', 'none', 'minimal', 'low', 'medium', 'high'])
    .optional()
    .transform((value) => value ?? 'minimal'),
  OPENAI_CORE_MAX_OUTPUT_TOKENS: integer(1024, 256, 4096),
  OPENAI_HARDENING_MAX_OUTPUT_TOKENS: integer(600, 128, 4096),
  /** US dollars with at most two decimal places, more than 0 and at most 1,000. */
  OPENAI_DAILY_SPEND_CAP_USD: z
    .string()
    .regex(/^\d{1,4}(?:\.\d{1,2})?$/)
    .transform(Number)
    .pipe(z.number().gt(0).max(1000))
    .optional()
    .transform((value) => value ?? 25),
  OPENAI_ATTEMPT_SPEND_SHARE_PCT: integer(80, 10, 100),
  /** `1` or `true` blocks attempts and hardening; `0`, `false`, or unset does not. */
  PIGGY_KILL_SWITCH: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(['0', '1', 'true', 'false']))
    .transform((value) => value === '1' || value === 'true')
    .optional()
    .transform((value) => value ?? false),
  RATE_LIMIT_ATTEMPTS_PER_MIN: integer(6, 1, 60),
  RATE_LIMIT_BURST: integer(3, 1, 20),
  RATE_LIMIT_ATTEMPTS_PER_DAY: integer(150, 1, 1000),
  RATE_LIMIT_WALLET_PER_MIN: integer(10, 1, 120),
  MAX_PROMPT_CHARS: integer(2000, 1, PROMPT_CHARS_HARD_MAX),
  HARDENING_MAX_JOBS_PER_HOUR: integer(30, 1, 120),
  /** record_attempt accepts 1 to 20 (section 5.4). */
  HARDENING_MAX_JOBS_PER_USER_PER_HOUR: integer(3, 1, 20),
  /** 0 disables the traffic filter (section 6.10). */
  HARDENING_TRAFFIC_WINDOW: integer(500, 0, 5000),
  HARDENING_TRAFFIC_MAX_BPS: integer(100, 10, 1000),
  RAW_PROMPT_RETENTION_DAYS: integer(30, 1, 365),
  /** Only the mock rails exist in v1 (CH-4). */
  PAYMENTS_MODE: z
    .literal('mock')
    .optional()
    .transform((): 'mock' => 'mock'),
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  VERCEL_URL: vercelHost,
  VERCEL_BRANCH_URL: vercelHost,
} satisfies Record<ServerEnvName, z.ZodType>)

export type ServerEnv = DeepReadonly<z.output<typeof ServerEnvSchema>>

let cached: ServerEnv | null = null

/**
 * Parses and returns the server settings, reading the environment on the
 * first call only. Throws a ServerEnvError naming every invalid variable.
 */
export function getEnv(): ServerEnv {
  if (cached) return cached
  const raw = readRawEnv()
  const input = Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, value === '' ? undefined : value])
  )
  const result = ServerEnvSchema.safeParse(input)
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '(root)')))].sort()
    throw new ServerEnvError('invalid', names)
  }
  cached = deepFreeze(result.data)
  return cached
}

/** The settings that have no default and that requireEnv() can demand. */
export type RequirableEnvName = 'OPENAI_API_KEY' | 'CRON_SECRET' | 'LIVE_VIEW_TOKEN'

/**
 * Returns the settings with the named secrets guaranteed to be set, or throws
 * a ServerEnvError that lists the missing names, never a value.
 */
export function requireEnv<Name extends RequirableEnvName>(
  ...names: Name[]
): ServerEnv & { readonly [Key in Name]: string } {
  const env = getEnv()
  const missing = names.filter((name) => env[name] === undefined)
  if (missing.length > 0) throw new ServerEnvError('missing', [...new Set(missing)].sort())
  return env as ServerEnv & { readonly [Key in Name]: string }
}
