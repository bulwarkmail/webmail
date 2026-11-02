/**
 * Helpers for the enterprise-pack specs (22-ent-*.spec.ts). They run against
 * a local dev or production server on a VM 106 test Stalwart with the
 * throwaway ent-* accounts only. They never reset an account and never touch
 * usera/userb/userc, review, e2e-*, org-* or ha-* accounts.
 *
 * Start them with C:\Users\info\worktrees\enterprise-rig\run-spec.sh, which
 * checks the ent-* accounts on the VM first and sets:
 *   IT_WEBMAIL_URL     the Bulwark server (scratch ADMIN_CONFIG_DIR)
 *   IT_JMAP_URL        the Stalwart server
 *   IT_ENT_PASSWORD    password of the ent-* accounts (vault "Stalwart test – ent-* throwaway accounts")
 *   IT_ADMIN_PASSWORD  the Bulwark server's admin password (vault "Bulwark dev rig – enterprise pack admin")
 *   IT_ENT_SERVER      label for screenshots and logs: 0.16 or 1.0
 *   IT_ACCOUNT_USERS   ent-alice,ent-bob,ent-carol (the suite's global setup polls the first one)
 *
 * Setup goes through the admin API and JMAP, never through admin pages, so a
 * spec also runs against a build of main to show it can fail there.
 */
import { type Browser, type BrowserContext, type Page, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WEBMAIL_URL, JMAP_URL } from './config';
import { accountSwitcher, neutralizeDevOverlay } from './app';
import { JmapClient } from './jmap';

export const ENT_PASSWORD = process.env.IT_ENT_PASSWORD ?? '';
export const ADMIN_PASSWORD = process.env.IT_ADMIN_PASSWORD ?? '';
export const ENT_SERVER = process.env.IT_ENT_SERVER ?? 'unknown';

export const ENT = {
  alice: 'ent-alice@example.org',
  bob: 'ent-bob@example.org',
  carol: 'ent-carol@example.org',
  dave: 'ent-dave@example.org',
  sec: 'ent-sec@example.org',
  team: 'ent-team@example.org',
} as const;

/**
 * Call at the top of every ent spec: refuses to run without the passwords
 * or with the suite's accounts configured (the suite's global setup would
 * poll an account that doesn't exist and get this PC banned).
 */
export function requireEntEnv(): void {
  if (!ENT_PASSWORD || !ADMIN_PASSWORD) {
    throw new Error('Set IT_ENT_PASSWORD and IT_ADMIN_PASSWORD (use enterprise-rig/run-spec.sh) to run the ent specs');
  }
  const users = (process.env.IT_ACCOUNT_USERS ?? '').split(',').filter(Boolean);
  if (users.length === 0 || users.some((u) => !u.startsWith('ent-'))) {
    throw new Error('IT_ACCOUNT_USERS must name ent-* accounts only (use enterprise-rig/run-spec.sh)');
  }
}

/** English UI (Playwright's default locale gives German) at desktop or phone width. */
export function contextOptions(phone = false) {
  return {
    baseURL: WEBMAIL_URL,
    locale: 'en-US',
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  };
}

// Not under integration/test-results: Playwright empties that folder on
// every run, which would cost an admin login per run (5 per 15 minutes).
const stateDir = path.join(tmpdir(), 'bulwark-ent-it');
const adminStatePath = () => path.join(stateDir, `ent-admin-${new URL(WEBMAIL_URL).port || '80'}.json`);

/** A browser context signed in to /admin through the API, stored and reused across runs. */
export async function adminContext(browser: Browser, phone = false): Promise<BrowserContext> {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  if (existsSync(adminStatePath())) {
    const context = await browser.newContext({ ...contextOptions(phone), storageState: adminStatePath() });
    const res = await context.request.get('/api/admin/auth');
    if (res.ok() && (await res.json().catch(() => ({})))?.authenticated !== false) return context;
    await context.close();
  }
  const context = await browser.newContext(contextOptions(phone));
  const res = await context.request.post('/api/admin/auth', {
    data: { password: ADMIN_PASSWORD },
    headers: { Origin: new URL(WEBMAIL_URL).origin },
  });
  expect(res.ok(), `admin sign-in: ${res.status()}`).toBe(true);
  await context.storageState({ path: adminStatePath() });
  return context;
}

/** The policy as the admin sees it. */
export async function getPolicy(admin: BrowserContext): Promise<Record<string, unknown>> {
  const res = await admin.request.get('/api/admin/policy');
  expect(res.ok()).toBe(true);
  return res.json();
}

export async function putPolicy(admin: BrowserContext, policy: Record<string, unknown>): Promise<void> {
  const res = await admin.request.put('/api/admin/policy', { data: policy });
  expect(res.ok(), await res.text()).toBe(true);
}

/**
 * Runs `fn` with `organisation` (and optionally `scopes`/`restrictions`)
 * merged into the policy, and puts the saved policy back afterwards, also
 * when `fn` fails.
 */
export async function withPolicy<T>(
  admin: BrowserContext,
  patch: { organisation?: Record<string, unknown>; scopes?: unknown[]; restrictions?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const saved = await getPolicy(admin);
  const next = {
    ...saved,
    ...(patch.organisation ? { organisation: { ...(saved.organisation as object ?? {}), ...patch.organisation } } : {}),
    ...(patch.scopes ? { scopes: patch.scopes } : {}),
    ...(patch.restrictions ? { restrictions: { ...(saved.restrictions as object ?? {}), ...patch.restrictions } } : {}),
  };
  await putPolicy(admin, next);
  try {
    return await fn();
  } finally {
    await putPolicy(admin, saved);
  }
}

/** Sign in a fresh context as one of the ent-* accounts. */
export async function userPage(browser: Browser, email: string, phone = false): Promise<Page> {
  if (!email.startsWith('ent-')) throw new Error(`userPage: ${email} is not an ent-* account`);
  const context = await browser.newContext(contextOptions(phone));
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', email);
  await page.fill('#password', ENT_PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
  return page;
}

/** Screenshots for local-data/enterprise-pack-screenshots/, named by package, feature and server. Standard theme. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.IT_ENT_SCREENSHOTS;
  if (!dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}-${ENT_SERVER}.png`), fullPage: false });
}

const clients = new Map<string, Promise<JmapClient>>();

/** A JMAP client for setup and server-side checks, one per account and run. */
export function jmapAs(email: string): Promise<JmapClient> {
  if (!email.startsWith('ent-')) throw new Error(`jmapAs: ${email} is not an ent-* account`);
  let client = clients.get(email);
  if (!client) {
    client = JmapClient.connect(email, ENT_PASSWORD);
    clients.set(email, client);
  }
  return client;
}

const SUBMISSION = 'urn:ietf:params:jmap:submission';
const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';

/**
 * Delivers a message between ent-* accounts with JMAP EmailSubmission (SMTP
 * on the VM 106 containers has no TLS, so the suite's sendMail times out).
 * `headers` are raw header values, e.g. { 'SIO-Label': 'marking="INTERNAL"' }.
 */
export async function deliver(opts: {
  from: string; to: string[]; subject: string; text?: string; html?: string; headers?: Record<string, string>;
}): Promise<void> {
  const client = await jmapAs(opts.from);
  const identities = await client.identities();
  const identity = identities.find((i) => i.email === opts.from) ?? identities[0];
  const drafts = await client.mailboxByRole('drafts');
  const sent = await client.mailboxByRole('sent');
  const create: Record<string, unknown> = {
    mailboxIds: { [drafts!.id]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ email: opts.from }],
    to: opts.to.map((email) => ({ email })),
    subject: opts.subject,
    bodyValues: { t: { value: opts.text ?? 'Test message' }, ...(opts.html ? { h: { value: opts.html } } : {}) },
    textBody: [{ partId: 't', type: 'text/plain' }],
    ...(opts.html ? { htmlBody: [{ partId: 'h', type: 'text/html' }] } : {}),
  };
  for (const [name, value] of Object.entries(opts.headers ?? {})) create[`header:${name}:asRaw`] = ` ${value}`;
  const res = await client.request([
    ['Email/set', { accountId: client.accountId, create: { m: create } }, '0'],
    ['EmailSubmission/set', {
      accountId: client.accountId,
      create: { s: { identityId: identity.id, emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts!.id}`]: null, [`mailboxIds/${sent!.id}`]: true, 'keywords/$draft': null } },
    }, '1'],
  ], [CORE, MAIL, SUBMISSION]);
  const created = res.methodResponses?.[0]?.[1]?.created?.m;
  const submitted = res.methodResponses?.[1]?.[1]?.created?.s;
  if (!created || !submitted) throw new Error(`deliver failed: ${JSON.stringify(res.methodResponses).slice(0, 600)}`);
}

/** The raw RFC 5322 text of a message, by blobId, from the account's download URL. */
export async function rawMessage(email: string, blobId: string): Promise<string> {
  const client = await jmapAs(email);
  const url = `${JMAP_URL}/jmap/download/${client.accountId}/${blobId}/m.eml?accept=message/rfc822`;
  const res = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(`${email}:${ENT_PASSWORD}`).toString('base64') } });
  if (!res.ok) throw new Error(`download ${blobId}: ${res.status}`);
  return res.text();
}
