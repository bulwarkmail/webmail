/**
 * Multi-instance (#1066): starting, killing and restarting replicas, losing
 * the store, and moving a single instance onto it. These start and stop the
 * rig's containers over ssh (helpers/ha.ts `compose`, `vm`), so they run one
 * after another and leave the rig running with three replicas at the end.
 *
 * The rig's Valkey keeps its data on a volume (AOF), so stopping it is an
 * outage, not data loss; `down -v` is the deliberate "empty store".
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';
import { JmapClient } from './helpers/jmap';
import {
  A, B, C, HA, HA_USERS, SPREAD_MS,
  adminClient, client, compose, eventually, forgetAdminSession, json, pluginZip,
  requireHaEnv, signIn, template, testIp, uniq, valkey, vm, waitReady,
} from './helpers/ha';

// One worker runs them in file order (playwright.integration.config.ts); not
// serial, so one failure doesn't hide the rest.
test.setTimeout(600_000);

const REPLICAS = 'ha-1 ha-2 ha-3';

test.beforeAll(() => requireHaEnv());

/** Start the store, stub and LB, then the replicas all at once. */
async function freshRig(opts: { wipe: boolean }): Promise<void> {
  if (opts.wipe) {
    compose('--profile single --profile import down -v --remove-orphans');
    forgetAdminSession();
  }
  compose('up -d valkey ha-wopi-stub ha-lb');
  await eventually(async () => valkey('PING') === 'PONG', 60_000, 1000);
  compose(`up -d ${REPLICAS}`);
  await waitReady(HA.replicas);
}

/** Sign in through the load balancer in a real browser, with "remember me". */
async function browserUser(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: HA.lb, locale: 'en-US', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
  await page.fill('#username', email);
  await page.fill('#password', HA.password);
  const remember = page.getByLabel(/remember me/i);
  if (await remember.count()) await remember.check({ force: true });
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60_000 });
  return page;
}

/** Still signed in after a full reload (no login form). */
async function expectStillSignedIn(page: Page): Promise<void> {
  await page.reload();
  await expect(accountSwitcher(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#password')).toHaveCount(0);
}

test('three replicas started at once on an empty store agree on one session secret', async () => {
  await freshRig({ wipe: true });
  expect(valkey('EXISTS bulwark:kv:session-secret')).toBe('1');
  const user = await client(A);
  try {
    await signIn(user, HA_USERS.alice, A);
    for (const origin of [B, C]) {
      const res = await user.get(`${origin}/api/auth/session`);
      expect(res.status(), `session made on A, read on ${origin}`).toBe(200);
      expect((await json<{ username: string }>(res)).username).toBe(HA_USERS.alice);
    }
  } finally {
    await user.dispose();
  }
});

test('background jobs run on one replica and move when it is killed', async () => {
  const holder = () => valkey('GET bulwark:lease:scheduler-leader');
  const { value: first } = await eventually(async () => holder(), 60_000, 1000);
  expect(first).toMatch(/^ha-[123]-/);
  const container = first.split('-').slice(0, 2).join('-');
  // Only the holder logs scheduler activity.
  const scheduling = (name: string) => vm(`docker logs ${name} 2>&1 | grep -c "scheduler: leading" || true`).trim();
  expect(Number(scheduling(container))).toBeGreaterThanOrEqual(1);
  for (const other of ['ha-1', 'ha-2', 'ha-3'].filter((n) => n !== container)) expect(scheduling(other)).toBe('0');

  vm(`docker kill ${container}`);
  try {
    const { value: next, ms } = await eventually(async () => {
      const h = holder();
      return h && !h.startsWith(`${container}-`) ? h : null;
    }, 90_000, 1000);
    expect(next).toMatch(/^ha-[123]-/);
    console.log(`[ha] scheduler moved from ${first} to ${next} after ${ms} ms`);
  } finally {
    vm(`docker start ${container}`);
    await waitReady(HA.replicas);
  }
});

test('killing a replica while a user works through the load balancer keeps the user signed in', async ({ browser }) => {
  const page = await browserUser(browser, HA_USERS.alice);
  vm('docker kill ha-2');
  try {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      await expectStillSignedIn(page);
      await page.waitForTimeout(1000);
    }
  } finally {
    vm('docker start ha-2');
    await waitReady(HA.replicas);
    await page.context().close();
  }
});

test('a rolling restart of all three keeps a user reading and sending mail', async ({ browser }) => {
  const page = await browserUser(browser, HA_USERS.alice);
  const bob = await JmapClient.connect(HA_USERS.bob, HA.password);
  const sent: string[] = [];
  const work = async (round: string) => {
    await expectStillSignedIn(page);
    const subject = `HA rolling ${round} ${uniq()}`;
    await page.keyboard.press('c');
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 30_000 });
    const to = page.locator('[data-testid="composer-to"] input').first();
    await to.click({ timeout: 30_000 });
    await to.fill(HA_USERS.bob);
    await to.press('Enter');
    await page.locator('[data-testid="composer-subject"]').fill(subject);
    // Send stays disabled while the body is empty.
    await page.locator('[data-testid="email-composer"] [contenteditable="true"]').first().click({ timeout: 30_000 });
    await page.keyboard.type(`Sent while ${round}.`);
    await page.locator('[data-testid="composer-send"]:visible').first().click({ timeout: 30_000 });
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'hidden', timeout: 30_000 });
    sent.push(subject);
  };
  try {
    for (const name of ['ha-1', 'ha-2', 'ha-3']) {
      const restart = Promise.resolve().then(() => vm(`docker restart -t 15 ${name}`));
      await work(`during ${name}`);
      await restart;
      await waitReady(HA.replicas);
      await work(`after ${name}`);
    }
    for (const subject of sent) await bob.waitForEmail(subject, { timeoutMs: 60_000 });
  } finally {
    await page.context().close();
  }
});

test('with the store down, readiness fails, logins are refused, nothing is lost, and all recovers', async ({ browser }) => {
  // Signed in through the load balancer, which (like plain nginx) ignores readiness.
  const page = await browserUser(browser, HA_USERS.alice);
  const user = await client(A);
  await signIn(user, HA_USERS.carol, A);
  const marker = uniq('before-outage');
  const settings = (origin: string) => user.get(`${origin}/api/settings`, { headers: { 'x-settings-username': HA_USERS.carol, 'x-settings-server': HA.jmap } });
  const save = (origin: string, value: string) => user.post(`${origin}/api/settings`, {
    data: { username: HA_USERS.carol, serverUrl: HA.jmap, settings: { haMarker: value } },
  });
  expect((await save(A, marker)).status()).toBe(200);
  compose('stop valkey');
  try {
    for (const origin of HA.replicas) {
      await eventually(async () => (await fetch(`${origin}/api/ready`)).status === 503, SPREAD_MS);
    }
    const ip = testIp();
    const adminTry = await client(B, ip);
    expect((await adminTry.post(`${B}/api/admin/auth`, { data: { password: HA.adminPassword } })).status(), 'admin login fails closed').toBe(503);
    await adminTry.dispose();
    const loginTry = await client(C, ip);
    const login = await loginTry.post(`${C}/api/auth/session`, { data: { serverUrl: HA.jmap, username: HA_USERS.carol, password: 'wrong' } });
    expect([429, 503], 'user login fails closed').toContain(login.status());
    await loginTry.dispose();
    const lost = await save(B, uniq('during-outage'));
    expect(lost.status(), 'a save during the outage is refused, not dropped').toBe(503);
    // A user who was signed in keeps reading mail: the browser talks to the mail server.
    await expectStillSignedIn(page);
  } finally {
    compose('start valkey');
  }
  await waitReady(HA.replicas, 60_000);
  const after = await json<{ settings: { haMarker?: string } }>(await settings(C));
  expect(after.settings.haMarker).toBe(marker);
  expect((await save(C, uniq('after-outage'))).status()).toBe(200);
  await user.dispose();
  await page.context().close();
});

test('an existing single instance moves onto the store with everything, and importing twice changes nothing', async () => {
  // 1. A single instance without the store collects data on its own volume.
  compose(`stop ${REPLICAS}`);
  compose('--profile single up -d ha-single');
  await waitReady([HA.single]);
  forgetAdminSession();
  const ip = testIp();
  const admin = await client(HA.single, ip);
  expect((await admin.post(`${HA.single}/api/admin/auth`, { data: { password: HA.adminPassword } })).status()).toBe(200);
  const appName = `Imported ${uniq()}`;
  expect((await admin.patch(`${HA.single}/api/admin/config`, { data: { appName } })).ok()).toBe(true);
  const policy = await json<Record<string, unknown> & { features: Record<string, unknown> }>(await admin.get(`${HA.single}/api/admin/policy`));
  expect((await admin.put(`${HA.single}/api/admin/policy`, { data: { ...policy, features: { ...policy.features, pluginsEnabled: true } } })).ok()).toBe(true);
  const pluginId = uniq('ha-import').toLowerCase();
  expect((await admin.post(`${HA.single}/api/admin/plugins`, {
    multipart: { file: { name: 'p.zip', mimeType: 'application/zip', buffer: await pluginZip(pluginId, { credentials: ['svc'] }) } },
  })).ok()).toBe(true);
  const user = await client(HA.single);
  await signIn(user, HA_USERS.dave, HA.single);
  const tpl = template('Imported template');
  expect((await user.post(`${HA.single}/api/settings`, { data: { username: HA_USERS.dave, serverUrl: HA.jmap, settings: { haMarker: appName, templates: [tpl], deletedTemplateIds: {} } } })).status()).toBe(200);
  expect((await user.post(`${HA.single}/api/plugin-secrets`, {
    data: { pluginId, credentialId: 'svc', label: 'svc', origin: 'https://api.example.org', inject: { type: 'bearer' }, secret: 'imported' },
  })).status()).toBe(200);
  const audit = await json<{ total: number }>(await admin.get(`${HA.single}/api/admin/audit?limit=1`));
  expect(audit.total).toBeGreaterThan(0);
  await admin.dispose();
  await user.dispose();
  compose('--profile single stop ha-single');

  // 2. Empty store; the instance starts with REDIS_URL and its old volume.
  compose(`rm -sf ${REPLICAS}`);
  compose('rm -sf valkey');
  vm('docker volume rm bulwark-ha_ha-valkey-data');
  compose('up -d valkey');
  await eventually(async () => valkey('PING') === 'PONG', 60_000, 1000);
  compose('--profile import up -d ha-migrate');
  await waitReady([HA.migrate]);
  const keys1 = valkey('DBSIZE');
  // 3. The other replicas join and serve all of it; their own dirs are empty.
  compose(`up -d ${REPLICAS}`);
  await waitReady(HA.replicas);
  forgetAdminSession();
  const replicaAdmin = await adminClient(B);
  expect((await (await fetch(`${C}/api/config`)).json()).appName).toBe(appName);
  const plugins = await json<Array<{ id: string }>>(await replicaAdmin.get(`${B}/api/admin/plugins`));
  expect(plugins.map((p) => p.id)).toContain(pluginId);
  const importedAudit = await json<{ total: number }>(await replicaAdmin.get(`${C}/api/admin/audit?limit=1`));
  expect(importedAudit.total).toBeGreaterThanOrEqual(audit.total);
  const dave = await client(A);
  await signIn(dave, HA_USERS.dave, A);
  const s = await json<{ settings: { haMarker?: string; templates?: Array<{ id: string }> } }>(
    await dave.get(`${B}/api/settings`, { headers: { 'x-settings-username': HA_USERS.dave, 'x-settings-server': HA.jmap } }),
  );
  expect(s.settings.haMarker).toBe(appName);
  expect(s.settings.templates?.map((t) => t.id)).toContain(tpl.id);
  const creds = await json<{ credentials: Array<{ credentialId: string; connected: boolean }> }>(await dave.get(`${C}/api/plugin-secrets?plugin=${pluginId}`));
  expect(creds.credentials).toEqual([expect.objectContaining({ credentialId: 'svc', connected: true })]);

  // 4. The import again: a restart of the importing instance changes nothing.
  const dump = () => valkey('--scan --pattern "bulwark:doc:*"').split('\n').sort().join('\n');
  const before = dump();
  compose('--profile import restart ha-migrate');
  await waitReady([HA.migrate]);
  expect(dump()).toBe(before);
  console.log(`[ha] store keys after import: ${keys1}`);

  // Leave the rig as three replicas.
  compose('--profile import stop ha-migrate');
  await dave.dispose();
  await replicaAdmin.dispose();
});

test('the same image as a single instance without a store works as before', async () => {
  compose('--profile single rm -sf ha-single');
  vm('docker volume rm bulwark-ha_ha-single-data || true');
  compose('--profile single up -d ha-single');
  await waitReady([HA.single]);
  const ready = await (await fetch(`${HA.single}/api/ready`)).json();
  expect(ready).toMatchObject({ ready: true, store: 'local' });
  const user = await client(HA.single);
  await signIn(user, HA_USERS.alice, HA.single);
  const marker = uniq('single');
  expect((await user.post(`${HA.single}/api/settings`, { data: { username: HA_USERS.alice, serverUrl: HA.jmap, settings: { haMarker: marker } } })).status()).toBe(200);
  const back = await json<{ settings: { haMarker?: string } }>(await user.get(`${HA.single}/api/settings`, { headers: { 'x-settings-username': HA_USERS.alice, 'x-settings-server': HA.jmap } }));
  expect(back.settings.haMarker).toBe(marker);
  const admin = await client(HA.single, testIp());
  expect((await admin.post(`${HA.single}/api/admin/auth`, { data: { password: HA.adminPassword } })).status()).toBe(200);
  const id = uniq('ha-single').toLowerCase();
  const install = await admin.post(`${HA.single}/api/admin/plugins`, {
    multipart: { file: { name: 'p.zip', mimeType: 'application/zip', buffer: await pluginZip(id) } },
  });
  expect(install.ok(), await install.text()).toBe(true);
  // The same files on disk as before (no store involved).
  const files = vm('docker exec ha-single sh -c "ls /app/data/admin /app/data/admin/plugins /app/data/settings | head -50"');
  expect(files).toContain('admin.json');
  expect(files).toContain(`${id}.js`);
  expect(files).toMatch(/[0-9a-f]{64}\.enc/);
  await user.dispose();
  await admin.dispose();
  compose('--profile single stop ha-single');
});
