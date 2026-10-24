import { z } from 'zod'

/**
 * Public settings (docs/ARCHITECTURE.md section 13): values that are safe in
 * the browser bundle. Next.js inlines NEXT_PUBLIC_* variables at build time,
 * and only for a literal `process.env.NAME` expression, so each one is read
 * that way. Nothing is read when the module is imported (R1-14).
 *
 * The public Supabase settings live in src/lib/supabase/env.ts (PP-01); this
 * module does not repeat them. It never reads a secret.
 */

/** A missing or invalid public setting. The message lists names only, never a value. */
export class PublicEnvError extends Error {
  readonly names: readonly string[]

  constructor(names: readonly string[]) {
    super(`Missing or invalid public environment variables: ${names.join(', ')}.`)
    this.name = 'PublicEnvError'
    this.names = names
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * NEXT_PUBLIC_APP_URL: the canonical origin, http or https, with no
 * credentials, path, query, or fragment (a trailing "/" is allowed).
 */
const AppUrlSchema = z
  .url({ protocol: /^https?$/, abort: true })
  .refine((value) => {
    const url = parseUrl(value)
    return (
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    )
  })
  .transform((value) => new URL(value).origin)

export type PublicEnv = {
  /** The canonical app origin, for example https://prompt-piggy.example (no trailing slash). */
  appOrigin: string
}

/**
 * Returns the app origin from NEXT_PUBLIC_APP_URL, or null when it is unset
 * or invalid. The Origin check uses this and fails closed on null.
 */
export function readAppOrigin(): string | null {
  const value = process.env.NEXT_PUBLIC_APP_URL
  if (!value) return null
  const result = AppUrlSchema.safeParse(value)
  return result.success ? result.data : null
}

/** Returns the public settings, or throws a PublicEnvError naming what is missing or invalid. */
export function getPublicEnv(): PublicEnv {
  const appOrigin = readAppOrigin()
  if (!appOrigin) throw new PublicEnvError(['NEXT_PUBLIC_APP_URL'])
  return { appOrigin }
}
