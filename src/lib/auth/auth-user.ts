import 'server-only'
import type { User } from '@supabase/supabase-js'
import type { ServerSupabaseClient } from '@/lib/auth/require-user'
import type { AuthUser } from '@/components/providers/auth-provider'

/**
 * Builds the only user data the game shell sends to the browser
 * (docs/ARCHITECTURE.md section 9.7; REVIEW-1 R1-13): the user id, the display
 * name, and the avatar URL. No token, email, or metadata is ever included.
 *
 * The name and avatar come from the player's own `profiles` row (RLS: owners
 * read their own row), which is a sanitized one-time snapshot of the Google
 * profile taken at sign-up (R2-06). They never come from `user_metadata`,
 * which the player can edit. Until that row exists, or when it cannot be
 * read, the shell shows a generic name and the initials avatar.
 */

export const FALLBACK_DISPLAY_NAME = 'Player'

const AVATAR_HOST = 'lh3.googleusercontent.com'
const MAX_DISPLAY_NAME_LENGTH = 64

/**
 * Accepts only https URLs on the one avatar host next.config.ts allows, so a
 * bad value falls back to initials instead of breaking next/image.
 */
export function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== AVATAR_HOST || url.username || url.password || url.port) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}

function displayNameOf(value: unknown): string {
  if (typeof value !== 'string') return FALLBACK_DISPLAY_NAME
  const name = value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
  return name === '' ? FALLBACK_DISPLAY_NAME : name
}

/** Exactly the three client-safe fields, built field by field. */
export function toAuthUser(
  user: Pick<User, 'id'>,
  profile: { display_name?: unknown; avatar_url?: unknown } | null
): AuthUser {
  return {
    userId: user.id,
    displayName: displayNameOf(profile?.display_name),
    avatarUrl: safeAvatarUrl(profile?.avatar_url),
  }
}

/** Reads the user's own profile row and returns the client-safe fields. Never throws. */
export async function loadAuthUser(supabase: ServerSupabaseClient, user: Pick<User, 'id'>): Promise<AuthUser> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name, avatar_url')
      .eq('id', user.id)
      .maybeSingle()
    if (error) return toAuthUser(user, null)
    return toAuthUser(user, data)
  } catch {
    return toAuthUser(user, null)
  }
}
