import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Page skeletons from the first paint (components/boot-skeleton). Two checks
// against the same production build as the perf and accessibility guards
// (`DEV_MOCK_JMAP=true npx next build --webpack`):
//
// - with every script request blocked, each route's server HTML shows the
//   skeleton of the right page and no spinner or "Loading" text;
// - from navigation to the loaded page, the layout shift stays at or under
//   0.01 on every route.
//
//   DEV_MOCK_JMAP=true npx next build --webpack
//   npm run test:boot-skeleton-guard
//   BOOT_GUARD_BASE_URL=http://localhost:3100 npm run test:boot-skeleton-guard   # against a running server
const port = Number(process.env.BOOT_GUARD_PORT || 3152);
const externalBaseUrl = (process.env.BOOT_GUARD_BASE_URL ?? "").replace(/\/+$/, "");
const adminDir = mkdtempSync(join(tmpdir(), "boot-guard-"));

export default defineConfig({
  testDir: ".",
  testMatch: /boot-skeleton-guard\.spec\.ts$/,
  timeout: 600_000,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["list"]] : "list",
  use: {
    baseURL: externalBaseUrl || `http://localhost:${port}`,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: externalBaseUrl ? undefined : {
    command: `npx next start -p ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
    cwd: process.cwd(),
    timeout: 120_000,
    env: {
      DEV_MOCK_JMAP: "true",
      JMAP_SERVER_URL: `http://localhost:${port}/api/dev-jmap`,
      SESSION_SECRET: "boot-guard-session-secret-0123456789abcdef",
      ADMIN_CONFIG_DIR: join(adminDir, "config"),
      ADMIN_STATE_DIR: join(adminDir, "state"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
