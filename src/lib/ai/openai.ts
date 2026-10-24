import 'server-only'
import OpenAI from 'openai'
import { isE2ETestMode } from '@/lib/e2e-helpers'
import { requireEnv } from '@/lib/env'

/**
 * The OpenAI client factory and the AI mode switch (docs/ARCHITECTURE.md
 * sections 8 and 8.7).
 *
 * - The client is created lazily on the first getOpenAI() call, so importing
 *   this module reads no environment and `next build` needs no key.
 * - OPENAI_API_KEY is read only through requireEnv() at that point. A missing
 *   key throws a ServerEnvError that names the variable, never a value. The
 *   key is never logged.
 * - The base URL is pinned to the public API, so a stray OPENAI_BASE_URL in a
 *   deployment cannot send the key anywhere else.
 * - SDK retries are off (maxRetries 0). Callers own their retry policy, so no
 *   hidden retry can break a time budget or multiply spend: the Decisions
 *   wrapper retries at most once, and only on a 5xx (section 8.2).
 */

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

let client: OpenAI | null = null

/** Returns the shared OpenAI client, building it from OPENAI_API_KEY on the first call. */
export function getOpenAI(): OpenAI {
  if (client) return client
  const { OPENAI_API_KEY } = requireEnv('OPENAI_API_KEY')
  client = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL, maxRetries: 0 })
  return client
}

export type AiMode = 'real' | 'fake'

/**
 * `fake` only when isE2ETestMode() is true (never in a production build);
 * otherwise `real`. In fake mode the attempt pipeline uses the fakes in
 * src/lib/ai/testing/ and never needs an OpenAI key.
 */
export function getAiMode(): AiMode {
  return isE2ETestMode() ? 'fake' : 'real'
}
