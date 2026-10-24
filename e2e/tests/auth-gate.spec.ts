import { expect, test } from '@playwright/test'

/**
 * The auth gate (PP-05; docs/ARCHITECTURE.md sections 7 and 11, T17 and T23).
 *
 * The first group needs no session and no working Supabase: the proxy and the
 * callback fail closed either way. The second group signs in through the
 * E2E-only test login against the local Supabase stack that CI starts; on a
 * machine without that stack the test login answers 404 and the group is
 * skipped, but in CI it must run.
 */

const NOTICE = 'Your Google photo and name are shown to other players and on the event projector.'

test.describe('without a session', () => {
  test('/play redirects to /login, which shows the notice before the Google button', async ({ page }) => {
    await page.goto('/play')
    await expect(page).toHaveURL(/\/login\?next=%2Fplay$/)
    await expect(page.getByText(NOTICE)).toBeVisible()
    await expect(page.getByTestId('sign-in-notice-retention')).toContainText('kept for 30 days')
    await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()
  })

  test('/live is not redirected to /login', async ({ page }) => {
    await page.goto('/live')
    expect(new URL(page.url()).pathname).toBe('/live')
  })

  test('/api/health is not redirected to /login', async ({ request }) => {
    // PP-21 adds the route; until then it is a 404, which is still not a redirect.
    const response = await request.get('/api/health', { maxRedirects: 0 })
    expect(response.status() >= 300 && response.status() < 400).toBe(false)
    expect(response.headers()['location'] ?? '').not.toContain('/login')
  })

  test('/auth/callback?code=bad lands on /auth/error', async ({ page }) => {
    await page.goto('/auth/callback?code=bad')
    await expect(page).toHaveURL(/\/auth\/error$/)
    await expect(page.getByTestId('auth-error-title')).toBeVisible()
  })

  test('/auth/callback?code=bad&next=//evil.example never leaves the app', async ({ page, baseURL }) => {
    await page.goto('/auth/callback?code=bad&next=%2F%2Fevil.example')
    expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? 'http://localhost:3000').origin)
    await expect(page).toHaveURL(/\/auth\/error$/)
  })

  test('the start page offers Google sign-in and no /live link', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('landing-sign-in')).toHaveAttribute('href', '/login')
    await expect(page.locator('a[href^="/live"]')).toHaveCount(0)
  })
})

test.describe('with the E2E test login', () => {
  test('sign in, see Play, reject cross-origin and GET sign-out, then sign out', async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin
    const email = `auth-gate-${test.info().workerIndex}-${Date.now()}@e2e.prompt-piggy.test`

    const login = await page.request.post('/api/test/login', { data: { email }, headers: { origin } })
    test.skip(!process.env.CI && login.status() === 404, 'The test login needs E2E mode and a local Supabase stack.')
    expect(login.status()).toBe(200)
    expect(await login.json()).toMatchObject({ ok: true })

    await page.goto('/')
    await expect(page.getByTestId('landing-play')).toHaveAttribute('href', '/play')

    const crossOrigin = await page.request.post('/auth/signout', {
      headers: { origin: 'https://evil.example' },
      maxRedirects: 0,
    })
    expect(crossOrigin.status()).toBe(403)

    const viaGet = await page.request.get('/auth/signout', { maxRedirects: 0 })
    expect(viaGet.status()).toBe(405)

    // Still signed in after both refusals.
    await page.goto('/')
    await expect(page.getByTestId('landing-play')).toBeVisible()

    const signOut = await page.request.post('/auth/signout', { headers: { origin }, maxRedirects: 0 })
    expect(signOut.status()).toBe(302)
    expect(new URL(signOut.headers()['location'] ?? '', origin).pathname).toBe('/')

    await page.goto('/')
    await expect(page.getByTestId('landing-sign-in')).toBeVisible()
    await page.goto('/play')
    await expect(page).toHaveURL(/\/login\?next=%2Fplay$/)
  })
})
