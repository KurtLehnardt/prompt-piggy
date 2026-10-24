import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Google sign-in (docs/ARCHITECTURE.md section 12.1). The browser Supabase
 * client is replaced by a fake that records the call.
 */
const signInWithOAuth = vi.fn()
const toastError = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth } }),
}))
vi.mock('sonner', () => ({ toast: { error: (message: string) => toastError(message) } }))

const { buildCallbackUrl, GoogleSignInButton } = await import('./google-sign-in-button')

beforeEach(() => {
  signInWithOAuth.mockReset()
  signInWithOAuth.mockResolvedValue({ data: { provider: 'google', url: 'https://example.invalid' }, error: null })
  toastError.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('GoogleSignInButton', () => {
  it('signs in with Google, the callback with next=/play, and the account chooser', async () => {
    render(<GoogleSignInButton />)
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }))
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1))
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/play`,
        queryParams: { prompt: 'select_account' },
      },
    })
  })

  it('passes a validated next through to the callback', async () => {
    render(<GoogleSignInButton next="/me?x=1" />)
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }))
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1))
    const redirectTo = signInWithOAuth.mock.calls[0][0].options.redirectTo as string
    expect(new URL(redirectTo).searchParams.get('next')).toBe('/me?x=1')
  })

  it('disables itself while Google opens', async () => {
    signInWithOAuth.mockReturnValue(new Promise(() => {}))
    render(<GoogleSignInButton />)
    const button = screen.getByRole('button', { name: /sign in with google/i })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('google-sign-in').hasAttribute('disabled')).toBe(true))
  })

  it('shows an error toast and re-enables when sign-in cannot start', async () => {
    signInWithOAuth.mockResolvedValue({ data: { provider: 'google', url: null }, error: new Error('offline') })
    render(<GoogleSignInButton />)
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('google-sign-in').hasAttribute('disabled')).toBe(false))
  })
})

describe('buildCallbackUrl', () => {
  it('keeps slashes readable and encodes query characters', () => {
    expect(buildCallbackUrl('https://prompt-piggy.vercel.app')).toBe(
      'https://prompt-piggy.vercel.app/auth/callback?next=/play'
    )
    const url = new URL(buildCallbackUrl('https://prompt-piggy.vercel.app', '/me?x=1&y=2'))
    expect(url.pathname).toBe('/auth/callback')
    expect([...url.searchParams.keys()]).toEqual(['next'])
    expect(url.searchParams.get('next')).toBe('/me?x=1&y=2')
  })
})
