import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AuthProvider, useAuth, useOptionalAuth, type AuthUser } from './auth-provider'

/** AuthProvider in the ui vitest project (REVIEW-1 R1-13). */
const USER: AuthUser = {
  userId: '00000000-0000-4000-8000-000000000004',
  displayName: 'Pat Player',
  avatarUrl: 'https://lh3.googleusercontent.com/a/example=s96-c',
}

afterEach(() => {
  cleanup()
})

function Show() {
  const user = useAuth()
  return <pre data-testid="user">{JSON.stringify(user)}</pre>
}

function ShowOptional() {
  const user = useOptionalAuth()
  return <span data-testid="optional">{user ? user.displayName : 'none'}</span>
}

describe('AuthProvider', () => {
  it('provides the signed-in player to useAuth()', () => {
    render(
      <AuthProvider user={USER}>
        <Show />
      </AuthProvider>
    )
    expect(JSON.parse(screen.getByTestId('user').textContent ?? '')).toEqual(USER)
  })

  it('exposes only userId, displayName, and avatarUrl, even if more is passed', () => {
    const extra = { ...USER, email: 'pat@example.com', accessToken: 'x'.repeat(8) } as AuthUser
    render(
      <AuthProvider user={extra}>
        <Show />
      </AuthProvider>
    )
    const value = JSON.parse(screen.getByTestId('user').textContent ?? '')
    expect(Object.keys(value).sort()).toEqual(['avatarUrl', 'displayName', 'userId'])
    expect(JSON.stringify(value)).not.toContain('pat@example.com')
  })

  it('allows a missing avatar', () => {
    render(
      <AuthProvider user={{ ...USER, avatarUrl: null }}>
        <Show />
      </AuthProvider>
    )
    expect(JSON.parse(screen.getByTestId('user').textContent ?? '').avatarUrl).toBeNull()
  })

  it('useOptionalAuth() returns null outside the provider', () => {
    render(<ShowOptional />)
    expect(screen.getByTestId('optional').textContent).toBe('none')
  })

  it('useAuth() throws outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Show />)).toThrow(/inside AuthProvider/)
    vi.restoreAllMocks()
  })
})
