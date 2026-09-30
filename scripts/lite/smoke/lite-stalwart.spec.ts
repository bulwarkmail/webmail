import { test, expect, type Page } from "@playwright/test";
import { stalwartClientId, stalwartOrigin, stalwartPrefixes } from "./playwright.stalwart.config";

/**
 * Drives the Stalwart Application bundle (demo build) through the Stalwart
 * emulator in scripts/lite/serve.mjs. Real-server verification is recorded
 * in the PR; this keeps the serving contract from regressing.
 *
 * What it proves, under two different prefixes of the same zip:
 *   - /<prefix> redirects, /<prefix>/ boots without a redirect loop and ends
 *     on the login page of a real locale,
 *   - Stalwart's rewrites reach the app (mount prefix, OAuth client id),
 *   - the demo account signs in and surface switches stay client-side
 *     (no document load), although Stalwart labels RSC payloads
 *     application/octet-stream,
 *   - deep links and unknown paths survive a full reload,
 *   - nothing is requested outside the prefix, no chunk is answered with
 *     the index.html fallback, and the console stays clean.
 */

interface Watch {
  outside: string[];
  htmlAssets: string[];
  documents: string[];
  errors: string[];
}

function watch(page: Page, prefix: string): Watch {
  const seen: Watch = { outside: [], htmlAssets: [], documents: [], errors: [] };
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.origin !== stalwartOrigin) return;
    if (!url.pathname.startsWith(`${prefix}/`)) seen.outside.push(url.pathname);
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) seen.documents.push(url.pathname);
  });
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.pathname.includes("/_next/") && (res.headers()["content-type"] ?? "").startsWith("text/html")) seen.htmlAssets.push(url.pathname);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" || /hydrat/i.test(msg.text())) seen.errors.push(msg.text());
  });
  page.on("pageerror", (err) => seen.errors.push(err.message));
  return seen;
}

for (const prefix of stalwartPrefixes) {
  test.describe(`Stalwart bundle mounted at ${prefix}`, () => {
    test("serves the entry for every route with both rewrites applied", async ({ request }) => {
      const bare = await request.get(prefix, { maxRedirects: 0 });
      expect(bare.status()).toBe(302);
      expect(bare.headers().location).toBe(`${prefix}/`);

      for (const path of [`${prefix}/`, `${prefix}/en/mail/thread/abc`, `${prefix}/nope`]) {
        const res = await request.get(path);
        expect(res.headers()["cache-control"]).toBe("no-cache");
        const html = await res.text();
        expect(html).toContain(`<base href="${prefix}/" />`);
        expect(html).toContain(`<meta name="oauth-client-id" content="${stalwartClientId}" />`);
      }
      const shell = await request.get(`${prefix}/en/mail/index.html`);
      expect(shell.headers()["cache-control"]).toContain("immutable");
      const rsc = await request.get(`${prefix}/en/mail/index.txt`);
      expect(rsc.headers()["content-type"]).toBe("application/octet-stream");
    });

    test("boots, signs in, switches surfaces client-side and survives reloads", async ({ page }) => {
      const seen = watch(page, prefix);

      await page.goto(`${prefix}/`);
      await page.waitForURL(new RegExp(`${prefix}/en/login$`), { timeout: 30_000 });
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__BULWARK_LITE_MOUNT__)).toBe(prefix);
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__BULWARK_LITE_OAUTH_CLIENT_ID__)).toBe(stalwartClientId);

      const demo = page.getByRole("button", { name: /demo/i }).first();
      await expect(demo).toBeVisible({ timeout: 30_000 });
      await demo.click();
      await page.waitForURL(new RegExp(`${prefix}/en/(mail/?.*)?$`), { timeout: 30_000 });
      await expect(page.locator("body")).toContainText(/inbox/i, { timeout: 30_000 });

      seen.documents.length = 0;
      for (const [name, url] of [["calendar", /\/calendar/], ["contacts", /\/contacts/], ["settings", /\/settings/]] as const) {
        await page.getByRole("link", { name: new RegExp(`^${name}`, "i") }).first().click();
        await page.waitForURL(url, { timeout: 30_000 });
        expect(new URL(page.url()).pathname.startsWith(`${prefix}/en/`)).toBe(true);
      }
      // Client-side: the RSC payloads were accepted despite octet-stream.
      expect(seen.documents).toEqual([]);

      await page.goto(`${prefix}/en/calendar/week/2026-09-17`);
      await expect(page.locator("body")).toContainText(/September 2026/, { timeout: 30_000 });
      expect(new URL(page.url()).pathname).toMatch(new RegExp(`^${prefix}/en/calendar/\\w+/2026-09-17$`));

      await page.goto(`${prefix}/nope/at/all`);
      await page.waitForURL(new RegExp(`${prefix}/en/(mail/.*)?$`), { timeout: 30_000 });

      expect(seen.outside).toEqual([]);
      expect(seen.htmlAssets).toEqual([]);
      expect(seen.errors).toEqual([]);
    });
  });
}

test("a prefix the bundle was never told about still works (no build-time base path)", async ({ page }) => {
  // Both prefixes above come from the same zip; this pins that the entry did
  // not fall back to a baked path by checking every chunk URL it used.
  const chunkPrefixes = new Set<string>();
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.includes("/_next/static/")) chunkPrefixes.add(url.pathname.slice(0, url.pathname.indexOf("/_next/")));
  });
  await page.goto("/bulwark/en/login");
  await expect(page.getByRole("button", { name: /demo/i }).first()).toBeVisible({ timeout: 30_000 });
  expect([...chunkPrefixes]).toEqual(["/bulwark"]);
});
