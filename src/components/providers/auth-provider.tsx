'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * The signed-in player, as the browser sees it (docs/ARCHITECTURE.md section
 * 1.2 row 16: React context plus a hook, no state library).
 *
 * The (game) layout verifies the user on the server with requireUserPage()
 * and passes only these three fields. No access token, refresh token, email,
 * or metadata ever reaches a client prop; the browser's Supabase client keeps
 * its own session in cookies.
 */
export type AuthUser = {
  userId: string
  displayName: string
  avatarUrl: string | null
}

const AuthContext = createContext<AuthUser | null>(null)

export function AuthProvider({ user, children }: { user: AuthUser; children: ReactNode }) {
  const { userId, displayName, avatarUrl } = user
  // Copy the three fields so nothing else the caller passed can reach the context.
  const value = useMemo<AuthUser>(() => ({ userId, displayName, avatarUrl }), [userId, displayName, avatarUrl])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** The signed-in player. Throws when used outside AuthProvider. */
export function useAuth(): AuthUser {
  const user = useContext(AuthContext)
  if (!user) throw new Error('useAuth must be used inside AuthProvider.')
  return user
}

/** The signed-in player, or null outside AuthProvider. */
export function useOptionalAuth(): AuthUser | null {
  return useContext(AuthContext)
}
