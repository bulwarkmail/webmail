import { defineConfig } from '@playwright/test';

/**
 * Integration test config: drives the containerised webmail (+ Stalwart) stack
 * managed by integration/tests/global-setup.ts.
 *
 * Run:  npx playwright test -c playwright.integration.config.ts
 */
const WEBMAIL_URL = process.env.IT_WEBMAIL_URL ?? 'http://localhost:3000';

/**
 * Video capture mode, overridable via IT_VIDEO. Default `retain-on-failure`
 * keeps a .webm only for tests that fail. Set `IT_VIDEO=on` to record every
 * test (e.g. for a demo or to inspect a passing flow), `off` to disable, or
 * `on-first-retry` to record only when a test is retried. Videos land next to
 * the other artefacts under `integration/test-results/<test>/video.webm`.
 */
type VideoMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
const VIDEO_MODES: VideoMode[] = ['off', 'on', 'retain-on-failure', 'on-first-retry'];
const VIDEO: VideoMode = VIDEO_MODES.includes(process.env.IT_VIDEO as VideoMode)
  ? (process.env.IT_VIDEO as VideoMode)
  : 'retain-on-failure';

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
    video: VIDEO,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
