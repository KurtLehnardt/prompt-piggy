import { defineConfig, devices } from '@playwright/test'

// Port 3000 by default; PLAYWRIGHT_PORT moves it when 3000 is already taken locally.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const BASE_URL = `http://localhost:${PORT}`

/**
 * End-to-end tests run against `next dev` with E2E_TEST_MODE=true. In this
 * repository the flag never bypasses auth: it only enables fake AI models and
 * the local-only test login (ARCHITECTURE section 1.2, row 5).
 */
export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `E2E_TEST_MODE=true pnpm dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
