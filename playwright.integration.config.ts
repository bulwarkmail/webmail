import { defineConfig } from '@playwright/test';

/**
 * Integration test config: drives the containerised webmail (+ Stalwart) stack
 * managed by integration/tests/global-setup.ts. Distinct from the root
 * playwright.config.ts (fast UI smoke tests against `npm run dev`).
 *
 * Run:  npx playwright test -c playwright.integration.config.ts
 */
const WEBMAIL_URL = process.env.IT_WEBMAIL_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './integration/tests',
  // next dev compiles routes lazily and each test logs in fresh, so give
  // individual tests and their polling assertions generous headroom.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'integration/playwright-report' }]],
  outputDir: 'integration/test-results',
  globalSetup: './integration/tests/global-setup.ts',
  globalTeardown: './integration/tests/global-teardown.ts',
  use: {
    baseURL: WEBMAIL_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
