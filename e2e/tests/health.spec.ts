import { expect, test } from '@playwright/test'

test('the health page loads without signing in and reports ok', async ({ page }) => {
  const response = await page.goto('/health')

  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL(/\/health$/)
  await expect(page.getByTestId('health-status')).toHaveText('ok')
  await expect(page.getByTestId('health-app')).toHaveText('Prompt Piggy')
  for (const setting of ['url', 'publishable-key', 'secret-key']) {
    await expect(page.getByTestId(`health-supabase-${setting}`)).toHaveText(/^(yes|no)$/)
  }
})

test('the health page names the variable each Supabase setting came from', async ({ page }) => {
  // CI's e2e job sets NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  // to fake values; locally the settings may be unset, and then no name is shown.
  await page.goto('/health')
  const url = page.getByTestId('health-supabase-url')
  if ((await url.textContent()) === 'yes') {
    await expect(page.getByTestId('health-supabase-url-name')).toHaveText('NEXT_PUBLIC_SUPABASE_URL')
  }
  const key = page.getByTestId('health-supabase-publishable-key')
  if ((await key.textContent()) === 'yes') {
    await expect(page.getByTestId('health-supabase-publishable-key-name')).toHaveText(
      /^NEXT_PUBLIC_SUPABASE_(PUBLISHABLE|ANON)_KEY$/
    )
  }
  await expect(page.getByText(/fake-ci-/)).toHaveCount(0)
})
