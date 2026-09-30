import { defineConfig } from "@playwright/test";

// Smoke test for the Stalwart Application bundle (`npm run build:lite --
// --target=stalwart` with LITE_DEMO_MODE=true). serve.mjs --stalwart emulates
// how Stalwart serves an Application (exact zip-entry lookup, the root
// index.html for everything else with <base href> and the OAuth meta tag
// rewritten, immutable vs no-cache, Stalwart's MIME map) from the zip itself,
// mounted at two prefixes to prove the bundle does not care which.
const port = Number(process.env.LITE_STALWART_SMOKE_PORT || 4183);
export const stalwartOrigin = `http://localhost:${port}`;
export const stalwartPrefixes = ["/webmail", "/bulwark"];
export const stalwartClientId = "smoke-client";

export default defineConfig({
  testDir: ".",
  testMatch: /lite-stalwart\.spec\.ts$/,
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: stalwartOrigin,
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: `node scripts/lite/serve.mjs bulwark-lite-stalwart.zip ${port} --stalwart=${stalwartPrefixes.join(",")} --oauth-client-id=${stalwartClientId}`,
      port,
      reuseExistingServer: !process.env.CI,
      cwd: process.cwd(),
    },
  ],
});
