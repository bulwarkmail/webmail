import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Page skeletons from the first paint. See playwright.config.ts.
 */

type Seed = Record<string, string>;

const settings = (state: Record<string, unknown>): Seed => ({
  "settings-storage": JSON.stringify({ state, version: 12 }),
});
/** A stored session, so the skeleton is the page's and not the login card. */
const SIGNED_IN: Seed = {
  "auth-storage": JSON.stringify({ state: { isAuthenticated: true }, version: 0 }),
};

interface Case {
  path: string;
  /** The skeleton that must be the visible one. */
  surface: string;
  seed?: Seed;
  viewport?: { width: number; height: number };
  /** Attributes the boot script must have set on <html>. */
  attrs?: Record<string, string>;
}

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };

const CASES: Case[] = [
  { path: "/en", surface: "mail", attrs: { "data-boot-mail-layout": "split" } },
  { path: "/en/mail/folder/inbox", surface: "mail" },
  { path: "/en/mail/folder/inbox", surface: "mail", seed: settings({ mailLayout: "horizontal" }), attrs: { "data-boot-mail-layout": "horizontal" } },
  { path: "/en/mail/folder/inbox", surface: "mail", seed: settings({ mailLayout: "focus", density: "compact" }), attrs: { "data-boot-mail-layout": "focus" } },
  { path: "/en/mail/folder/inbox", surface: "mail", seed: settings({ interfaceLayout: "mountain-view" }), attrs: { "data-interface-layout": "mountain-view" } },
  { path: "/en/mail/message/x1", surface: "mail", attrs: { "data-boot-pane": "message" } },
  { path: "/en/mail/thread/x1", surface: "mail", viewport: PHONE, attrs: { "data-boot-pane": "thread" } },
  { path: "/en/mail/folder/inbox", surface: "mail", viewport: TABLET },
  { path: "/ar/mail/folder/inbox", surface: "mail" },
  { path: "/en/calendar/month/2026-11-04", surface: "calendar", attrs: { "data-boot-calendar-view": "month" } },
  { path: "/en/calendar/week/2026-11-04", surface: "calendar", attrs: { "data-boot-calendar-view": "week" } },
  { path: "/en/calendar/day/2026-11-04", surface: "calendar", attrs: { "data-boot-calendar-view": "day" } },
  { path: "/en/calendar/agenda/2026-11-04", surface: "calendar", attrs: { "data-boot-calendar-view": "agenda" } },
  { path: "/en/calendar/tasks/2026-11-04", surface: "calendar", attrs: { "data-boot-calendar-view": "tasks" } },
  { path: "/en/calendar/event/e1", surface: "calendar" },
  { path: "/en/calendar/week/2026-11-04", surface: "calendar", viewport: PHONE },
  { path: "/en/contacts", surface: "contacts" },
  { path: "/en/contacts/c1", surface: "contacts", viewport: PHONE, attrs: { "data-boot-pane": "detail" } },
  { path: "/en/files/Documents", surface: "files" },
  { path: "/en/apps/some-plugin/page", surface: "apps" },
  { path: "/en/settings", surface: "settings" },
  { path: "/en/settings/appearance", surface: "settings", attrs: { "data-boot-settings-tab": "appearance" } },
  { path: "/en/settings/themes", surface: "settings", attrs: { "data-boot-settings-tab": "appearance" } },
  { path: "/en/settings/filters", surface: "settings", viewport: PHONE, attrs: { "data-boot-pane": "detail" } },
  { path: "/en/pro", surface: "pro", seed: settings({ proInterface: true }) },
  { path: "/en/mail/folder/inbox", surface: "pro", seed: settings({ proInterface: true }), attrs: { "data-boot-pro": "on" } },
  { path: "/admin", surface: "admin" },
  { path: "/en/login", surface: "login" },
  { path: "/connector/calendar?view=week", surface: "calendar", attrs: { "data-boot-calendar-view": "week" } },
  { path: "/connector/settings?tab=filters", surface: "settings", attrs: { "data-boot-settings-tab": "filters" } },
  { path: "/connector/app", surface: "mail" },
  { path: "/connector/contacts", surface: "contacts" },
  { path: "/connector/files", surface: "files" },
  { path: "/protocol/mailto?url=mailto%3Aa%40example.com", surface: "mail" },
  { path: "/protocol/webcal?url=webcal%3A%2F%2Fexample.com%2Fa.ics", surface: "calendar" },
];

async function seedStorage(context: BrowserContext, items: Seed) {
  await context.addInitScript((seed) => {
    if (sessionStorage.getItem("__boot_guard_seeded")) return;
    localStorage.clear();
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    sessionStorage.setItem("__boot_guard_seeded", "1");
  }, items);
}

/** What a visitor sees: visible skeleton regions, spinners and text. */
async function firstScreen(page: Page) {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      if (el.closest(".sr-only")) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none";
    };
    const regions = [...document.querySelectorAll("[data-boot-skeleton]")].filter(shown).map((el) => el.getAttribute("data-boot-skeleton"));
    const spinners = [...document.querySelectorAll(".animate-spin")].filter(shown).length;
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      if (text && n.parentElement && shown(n.parentElement)) texts.push(text);
    }
    const attrs: Record<string, string> = {};
    for (const a of document.documentElement.attributes) attrs[a.name] = a.value;
    return { regions, spinners, text: texts.join(" "), attrs };
  });
}

test.describe("server HTML without JavaScript", () => {
  for (const c of CASES) {
    const name = `${c.path}${c.viewport ? ` @${c.viewport.width}` : ""}${c.seed ? ` ${Object.values(c.seed).join(" ").slice(0, 60)}` : ""}`;
    test(name, async ({ browser }) => {
      const context = await browser.newContext({ viewport: c.viewport ?? { width: 1440, height: 900 } });
      await seedStorage(context, { ...SIGNED_IN, ...(c.seed ?? {}) });
      const page = await context.newPage();
      await page.route(/\.js(\?|$)/, (route) => route.abort());
      await page.goto(c.path, { waitUntil: "load" });
      const screen = await firstScreen(page);
      expect(screen.regions, `visible skeletons on ${c.path}`).toEqual([c.surface]);
      expect(screen.spinners, "spinners").toBe(0);
      expect(screen.text, "visible text").not.toMatch(/loading|opening/i);
      for (const [name, value] of Object.entries(c.attrs ?? {})) expect(screen.attrs[name], name).toBe(value);
      await context.close();
    });
  }

  test("a visitor with nothing stored sees the login card's shape", async ({ browser }) => {
    for (const path of ["/en/mail/folder/inbox", "/en/calendar/week/2026-11-04", "/en/settings"]) {
      const context = await browser.newContext();
      await seedStorage(context, {});
      const page = await context.newPage();
      await page.route(/\.js(\?|$)/, (route) => route.abort());
      await page.goto(path, { waitUntil: "load" });
      const screen = await firstScreen(page);
      expect(screen.regions, path).toEqual(["login"]);
      expect(screen.attrs["data-boot-auth"]).toBe("out");
      await context.close();
    }
  });
});

/** Mock sign-in; the session is remembered, so fresh page loads restore it. */
async function signIn(page: Page) {
  await page.goto("/en/login");
  await page.getByRole("button", { name: /^sign in$/i }).first().click();
  await page.locator('[data-tour="email-list"]').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
}

/** Records every layout shift from the start of each page load. */
async function recordShifts(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __shifts: { value: number; at: number; nodes: string[] }[] };
    w.__shifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] })[]) {
          if (e.hadRecentInput) continue;
          w.__shifts.push({
            value: e.value,
            at: Math.round(e.startTime),
            nodes: (e.sources ?? []).map((s) => {
              const el = s.node as Element | undefined;
              return el && el.nodeType === 1 ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)}` : String(s.node?.nodeName);
            }),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* no layout-shift support */ }
  });
}

/** Waits until no skeleton shape is on screen any more, then a little longer. */
async function waitLoaded(page: Page) {
  await page.waitForFunction(() => {
    const visible = [...document.querySelectorAll("[data-boot-skeleton], .sk-shape")].some((el) => el.getClientRects().length > 0);
    return !visible;
  }, null, { timeout: 60_000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(1500);
}

test("layout shift from navigation to the loaded page stays at or under 0.01", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await recordShifts(context);
  const page = await context.newPage();
  await signIn(page);
  // A real message and thread from the mock mailbox.
  await page.locator('[data-tour="email-list"] [role="row"]').first().click();
  await page.waitForURL(/\/mail\/(message|thread)\//, { timeout: 30_000 }).catch(() => {});
  const messagePath = new URL(page.url()).pathname;

  const routes = [
    "/en/mail/folder/inbox",
    messagePath,
    "/en/calendar/month/2026-11-04",
    "/en/calendar/week/2026-11-04",
    "/en/calendar/day/2026-11-04",
    "/en/calendar/agenda/2026-11-04",
    "/en/contacts",
    "/en/files",
    "/en/settings/appearance",
    "/en/settings/filters",
  ];
  const over: string[] = [];
  for (const route of routes) {
    await page.goto(route, { waitUntil: "commit" });
    await waitLoaded(page);
    const shifts = await page.evaluate(() => (window as unknown as { __shifts: { value: number; at: number; nodes: string[] }[] }).__shifts);
    const total = shifts.reduce((sum, s) => sum + s.value, 0);
    if (total > 0.01) {
      over.push(`${route}: CLS ${total.toFixed(4)}\n` + shifts.map((s) => `  ${s.at}ms ${s.value.toFixed(4)} ${s.nodes.join(", ")}`).join("\n"));
    }
  }
  await context.close();
  expect(over, over.join("\n")).toEqual([]);
});
