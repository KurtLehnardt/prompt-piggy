import { expect, test } from '@playwright/test'

test('the health page loads without signing in and reports ok', async ({ page }) => {
  const response = await page.goto('/health')

  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL(/\/health$/)
  await expect(page.getByTestId('health-status')).toHaveText('ok')
  await expect(page.getByTestId('health-app')).toHaveText('Prompt Piggy')
  await expect(page.getByTestId('health-supabase-url')).toHaveText(/^(yes|no)$/)
  await expect(page.getByTestId('health-supabase-anon-key')).toHaveText(/^(yes|no)$/)
})
