import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * The login page (CH-3; REVIEW-2 R2-07; ARCHITECTURE assumption A5): both
 * notices are shown, before the sign-in button.
 */
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: vi.fn() } }),
}))

const { default: LoginPage } = await import('./page')

afterEach(() => {
  cleanup()
})

async function renderLogin(searchParams: Record<string, string | string[] | undefined> = {}) {
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }))
}

describe('LoginPage', () => {
  it('shows the projector notice word for word', async () => {
    await renderLogin()
    expect(
      screen.getByText('Your Google photo and name are shown to other players and on the event projector.')
    ).toBeTruthy()
  })

  it('shows the retention notice from assumption A5', async () => {
    await renderLogin()
    const retention = screen.getByTestId('sign-in-notice-retention').textContent ?? ''
    expect(retention).toContain('kept for 30 days')
    expect(retention).toMatch(/kept indefinitely as security regression data/)
  })

  it('shows both notices before the sign-in button', async () => {
    await renderLogin()
    const button = screen.getByRole('button', { name: /sign in with google/i })
    for (const id of ['sign-in-notice-projector', 'sign-in-notice-retention']) {
      const notice = screen.getByTestId(id)
      expect(notice.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('offers Google as the only sign-in method', async () => {
    await renderLogin()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })

  it('does not link to /live', async () => {
    await renderLogin()
    const hrefs = Array.from(document.querySelectorAll('a')).map((link) => link.getAttribute('href'))
    expect(hrefs.some((href) => href?.startsWith('/live'))).toBe(false)
  })

  it('accepts a next array or junk without crashing', async () => {
    await renderLogin({ next: ['/me', '/play'] })
    cleanup()
    await renderLogin({ next: '//evil.com' })
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeTruthy()
  })
})
