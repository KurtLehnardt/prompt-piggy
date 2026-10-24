import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * The start page, src/app/page.tsx (REVIEW-2 R2-07): sign-in call to action
 * when signed out, a Play link when signed in, and never a link to /live. The
 * test lives here because PP-05 owns src/app/page.tsx but not a test file
 * beside it; the page's only logic is the getCurrentUser() check.
 */
const getCurrentUser = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ getCurrentUser: () => getCurrentUser() }))

const { default: HomePage } = await import('@/app/page')

afterEach(() => {
  cleanup()
  getCurrentUser.mockReset()
})

function hrefs(): (string | null)[] {
  return Array.from(document.querySelectorAll('a')).map((link) => link.getAttribute('href'))
}

describe('HomePage', () => {
  it('shows the Google sign-in call to action when signed out, leading to /login', async () => {
    getCurrentUser.mockResolvedValue(null)
    render(await HomePage())
    const cta = screen.getByTestId('landing-sign-in')
    expect(cta.textContent).toMatch(/sign in with google/i)
    expect(cta.getAttribute('href')).toBe('/login')
    expect(screen.queryByTestId('landing-play')).toBeNull()
  })

  it('shows a Play link when signed in', async () => {
    getCurrentUser.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000005' })
    render(await HomePage())
    expect(screen.getByTestId('landing-play').getAttribute('href')).toBe('/play')
    expect(screen.queryByTestId('landing-sign-in')).toBeNull()
  })

  it.each([null, { id: 'signed-in' }])('never links to /live (user %j)', async (user) => {
    getCurrentUser.mockResolvedValue(user)
    render(await HomePage())
    expect(hrefs().some((href) => href?.startsWith('/live'))).toBe(false)
  })
})
