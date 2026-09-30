import { defineConfig } from "@playwright/test";

// Smoke test for a finished Lite export (`npm run build:lite` with
// LITE_DEMO_MODE=true). Serves out/ twice with the dependency-free static
// server: once with the SPA fallback the shipped host snippets apply, and
// once "plain" (unknown paths answer 404.html with status 404, like GitHub
// Pages or an S3 bucket) to exercise the 404 shim's park-and-replay path.
//
// LITE_SMOKE_BASE_URL points the suite at a server that is already running -
// the container image (Dockerfile.lite) - instead: nothing is started, and the
// spec swaps the plain-host test for checks of the image's nginx config.
export const externalBaseUrl = (process.env.LITE_SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
const port = Number(process.env.LITE_SMOKE_PORT || 4173);
export const plainPort = Number(process.env.LITE_SMOKE_PLAIN_PORT || port + 1);

export default defineConfig({
  testDir: ".",
  // lite-stalwart.spec.ts needs the Stalwart build (playwright.stalwart.config.ts).
  testMatch: /lite-demo\.spec\.ts$/,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: externalBaseUrl || `http://localhost:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: externalBaseUrl ? undefined : [
    {
      command: `node scripts/lite/serve.mjs out ${port}`,
      port,
      reuseExistingServer: !process.env.CI,
      cwd: process.cwd(),
    },
    {
      command: `node scripts/lite/serve.mjs out ${plainPort} "" --plain`,
      port: plainPort,
      reuseExistingServer: !process.env.CI,
      cwd: process.cwd(),
    },
  ],
});
