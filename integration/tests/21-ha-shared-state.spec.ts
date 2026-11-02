/**
 * Multi-instance (#1066): state written through one replica is seen through
 * the others. Runs against the three-replica rig (helpers/ha.ts), each step
 * against a named replica so it is deterministic. Nothing here restarts a
 * container; see 21-ha-lifecycle.spec.ts for that.
 *
 * Every test puts back what it changed (policy, config, plugins, branding).
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  A, B, C, HA, HA_USERS, SPREAD_MS,
  adminClient, client, eventually, impersonationToken, json, pkce, pluginZip,
  requireHaEnv, signIn, template, testIp, tinyPng, uniq,
} from './helpers/ha';

// One worker runs them in file order (playwright.integration.config.ts); not
// serial, so one failure doesn't hide the rest.
test.setTimeout(120_000);

let admin: APIRequestContext;

test.beforeAll(async () => {
  requireHaEnv();
  admin = await adminClient(A);
});

test.afterAll(async () => {
  await admin?.dispose();
});

type Policy = Record<string, unknown> & { restrictions: Record<string, unknown>; features: Record<string, unknown> };

async function getPolicy(origin = A): Promise<Policy> {
  const res = await admin.get(`${origin}/api/admin/policy`);
  expect(res.ok()).toBe(true);
  return json<Policy>(res);
}

async function putPolicy(policy: Policy, origin = A): Promise<void> {
  const res = await admin.put(`${origin}/api/admin/policy`, { data: policy });
  expect(res.ok(), await res.text()).toBe(true);
}

/** Plugins on for the duration of `fn` (they are off by default). */
async function withPlugins<T>(fn: () => Promise<T>): Promise<T> {
  const before = await getPolicy();
  if (before.features.pluginsEnabled !== true) {
    await putPolicy({ ...before, features: { ...before.features, pluginsEnabled: true } });
    // Every replica must see it before the test starts.
    for (const origin of HA.replicas) {
      await eventually(async () => (await getPolicy(origin)).features.pluginsEnabled === true, SPREAD_MS * 2);
    }
  }
  try {
    return await fn();
  } finally {
    const now = await getPolicy();
    await putPolicy({ ...now, features: { ...now.features, pluginsEnabled: before.features.pluginsEnabled } });
  }
}

test.describe('admin changes reach every replica', () => {
  test('a policy restriction saved on A reaches a user on B within 5 s', async () => {
    const before = await getPolicy();
    const user = await client(B);
    await signIn(user, HA_USERS.alice, B);
    const userPolicy = async () => json<Policy>(await user.get(`${B}/api/admin/policy`));
    try {
      const { density: _ignored, ...rest } = before.restrictions;
      await putPolicy({ ...before, restrictions: rest });
      await eventually(async () => !(await userPolicy()).restrictions.density, SPREAD_MS * 2);

      await putPolicy({ ...before, restrictions: { ...rest, density: { locked: true } } }, A);
      const { ms } = await eventually(async () => (await userPolicy()).restrictions.density, SPREAD_MS + 2000);
      expect(ms, 'time until replica B served the new policy').toBeLessThanOrEqual(SPREAD_MS);
    } finally {
      await putPolicy(before);
      await user.dispose();
    }
  });

  test('a config change on A shows on the login page served by C', async ({ browser }) => {
    const name = `HA rig ${uniq('n')}`;
    const res = await admin.patch(`${A}/api/admin/config`, { data: { appName: name } });
    expect(res.ok(), await res.text()).toBe(true);
    try {
      const { ms } = await eventually(async () => (await (await fetch(`${C}/api/config`)).json()).appName === name, SPREAD_MS + 2000);
      expect(ms).toBeLessThanOrEqual(SPREAD_MS);
      const context = await browser.newContext({ baseURL: C, locale: 'en-US' });
      const page = await context.newPage();
      await page.goto(`${C}/en/login`);
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
      await context.close();
    } finally {
      await admin.delete(`${A}/api/admin/config`, { data: { key: 'appName' } });
    }
  });

  test('frame-ancestors saved on A are in the CSP the proxy of B sends', async () => {
    const origin = `https://${uniq('frame')}.example.org`;
    const res = await admin.patch(`${A}/api/admin/config`, { data: { allowedFrameAncestors: `'self' ${origin}` } });
    expect(res.ok(), await res.text()).toBe(true);
    try {
      const { ms } = await eventually(async () => {
        const page = await fetch(`${B}/en/login`, { redirect: 'manual' });
        return (page.headers.get('content-security-policy') ?? '').includes(origin);
      }, SPREAD_MS + 2000);
      expect(ms).toBeLessThanOrEqual(SPREAD_MS);
    } finally {
      await admin.delete(`${A}/api/admin/config`, { data: { key: 'allowedFrameAncestors' } });
    }
  });

  test('a logo uploaded through A is served by B and named in C\'s config', async () => {
    const png = tinyPng();
    const res = await admin.post(`${A}/api/admin/branding`, {
      multipart: { slot: 'loginLogoLightUrl', file: { name: 'logo.png', mimeType: 'image/png', buffer: png } },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const { url } = await json<{ url: string }>(res);
    try {
      const served = await fetch(`${B}${url}`);
      expect(served.status).toBe(200);
      expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
      const { ms } = await eventually(async () => {
        const cfg = await (await fetch(`${C}/api/config`)).json();
        return typeof cfg.loginLogoLightUrl === 'string' && cfg.loginLogoLightUrl.split('?')[0] === url.split('?')[0];
      }, SPREAD_MS + 2000);
      expect(ms).toBeLessThanOrEqual(SPREAD_MS);
    } finally {
      await admin.delete(`${A}/api/admin/branding`, { data: { slot: 'loginLogoLightUrl' } });
    }
  });

  test('a plugin installed on A is listed and served by B and C', async () => {
    const id = uniq('ha-plugin').toLowerCase();
    const res = await admin.post(`${A}/api/admin/plugins`, {
      multipart: { file: { name: `${id}.zip`, mimeType: 'application/zip', buffer: await pluginZip(id) } },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const user = await client(B);
    await signIn(user, HA_USERS.alice, B);
    try {
      const { ms } = await eventually(async () => {
        const list = await json<{ plugins: Array<{ id: string }> }>(await user.get(`${B}/api/plugins`));
        return list.plugins.some((p) => p.id === id);
      }, SPREAD_MS + 2000);
      expect(ms).toBeLessThanOrEqual(SPREAD_MS);
      const bundle = await user.get(`${C}/api/admin/plugins/${id}/bundle`);
      expect(bundle.status()).toBe(200);
      expect(await bundle.text()).toContain(id);
    } finally {
      await admin.delete(`${A}/api/admin/plugins`, { data: { id } });
      await user.dispose();
    }
  });

  test('a plugin approval requested on A, decided on B, is approved on C', async () => {
    await withPlugins(async () => {
      const id = uniq('ha-approve').toLowerCase();
      const user = await client(A);
      await signIn(user, HA_USERS.bob, A);
      const req = await user.post(`${A}/api/plugin-approval-status`, {
        multipart: { file: { name: `${id}.zip`, mimeType: 'application/zip', buffer: await pluginZip(id) } },
      });
      expect(req.ok(), await req.text()).toBe(true);
      const { bundleHash, status } = await json<{ bundleHash: string; status: string }>(req);
      expect(status).toBe('pending');
      try {
        await eventually(async () => {
          const list = await json<{ entries: Array<{ pluginId: string; status: string }> }>(await admin.get(`${B}/api/admin/plugin-approvals`));
          return list.entries.some((e) => e.pluginId === id && e.status === 'pending');
        }, SPREAD_MS + 2000);
        const decide = await admin.post(`${B}/api/admin/plugin-approvals`, { data: { pluginId: id, bundleHash, decision: 'approved' } });
        expect(decide.ok(), await decide.text()).toBe(true);
        const { ms } = await eventually(async () => {
          const s = await json<{ status: string }>(await user.get(`${C}/api/plugin-approval-status?pluginId=${id}&bundleHash=${bundleHash}`));
          return s.status === 'approved';
        }, SPREAD_MS + 2000);
        expect(ms).toBeLessThanOrEqual(SPREAD_MS);
      } finally {
        await admin.delete(`${A}/api/admin/plugin-approvals?pluginId=${id}&bundleHash=${bundleHash}`);
        await user.dispose();
      }
    });
  });
});

test.describe('limits are counted across replicas', () => {
  test('admin login failures on A, B and C count together and the block holds on all three', async () => {
    const ip = testIp();
    // A fresh client per attempt: no device cookie, so the per-address limit applies.
    const attempt = async (origin: string, password: string) => {
      const ctx = await client(origin, ip);
      try {
        return (await ctx.post(`${origin}/api/admin/auth`, { data: { password } })).status();
      } finally {
        await ctx.dispose();
      }
    };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push(await attempt(HA.replicas[i % 3], `wrong-${i}`));
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    for (const origin of HA.replicas) {
      expect(await attempt(origin, 'wrong-again'), `wrong password via ${origin}`).toBe(429);
      expect(await attempt(origin, HA.adminPassword), `right password via ${origin}`).toBe(429);
    }
  });

  test('user login failures on A, B and C count together and the block holds on all three', async () => {
    const ip = testIp();
    const attempt = async (origin: string, password: string) => {
      const ctx = await client(origin, ip);
      try {
        return (await ctx.post(`${origin}/api/auth/session`, {
          data: { serverUrl: HA.jmap, username: HA_USERS.carol, password },
        })).status();
      } finally {
        await ctx.dispose();
      }
    };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push(await attempt(HA.replicas[i % 3], `wrong-${uniq()}`));
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    for (const origin of HA.replicas) {
      expect(await attempt(origin, `wrong-${uniq()}`), `via ${origin}`).toBe(429);
    }
  });
});

test.describe('sign-in hand-overs work from any replica', () => {
  test('a QR pairing started on A completes on B, once', async () => {
    const desktop = await client(A);
    await signIn(desktop, HA_USERS.alice, A);
    const phone = await client(B);
    try {
      const create = await desktop.post(`${A}/api/auth/pair/create`, {
        headers: { Origin: A },
        data: { webmail_base: A, password: HA.password },
      });
      expect(create.status(), await create.text()).toBe(200);
      const { pairing_code, status_id } = await json<{ pairing_code: string; status_id: string }>(create);
      expect((await json<{ status: string }>(await desktop.get(`${B}/api/auth/pair/status?id=${status_id}`))).status).toBe('pending');
      const redeem = await phone.post(`${B}/api/auth/pair/redeem`, { data: { pairing_code } });
      expect(redeem.status(), await redeem.text()).toBe(200);
      expect((await json<{ server_url: string }>(redeem)).server_url).toBeTruthy();
      expect((await json<{ status: string }>(await desktop.get(`${C}/api/auth/pair/status?id=${status_id}`))).status).toBe('redeemed');
      const again = await phone.post(`${C}/api/auth/pair/redeem`, { data: { pairing_code } });
      expect(again.status()).toBe(410);
    } finally {
      await desktop.dispose();
      await phone.dispose();
    }
  });

  test('a hand-off code issued on A is redeemed on B, and only once even when A, B and C race', async () => {
    const issue = async () => {
      const { verifier, challenge } = pkce();
      const ctx = await client(A, testIp());
      const res = await ctx.post(`${A}/api/auth/handoff/create`, {
        data: { code_challenge: challenge, state: 'ha', server_url: HA.jmap, username: HA_USERS.dave, password: HA.password },
      });
      const status = res.status();
      const body = await res.text();
      await ctx.dispose();
      expect(status, body).toBe(200);
      return { code: (JSON.parse(body) as { code: string }).code, verifier };
    };
    const app = await client(B, testIp());
    try {
      const first = await issue();
      const redeem = await app.post(`${B}/api/auth/handoff/redeem`, { data: { code: first.code, code_verifier: first.verifier } });
      expect(redeem.status(), await redeem.text()).toBe(200);
      expect((await json<{ username: string }>(redeem)).username).toBe(HA_USERS.dave);
      expect((await app.post(`${C}/api/auth/handoff/redeem`, { data: { code: first.code, code_verifier: first.verifier } })).status()).toBe(400);

      const second = await issue();
      const raced = await Promise.all(HA.replicas.map((origin) =>
        app.post(`${origin}/api/auth/handoff/redeem`, { data: { code: second.code, code_verifier: second.verifier } }).then((r) => r.status()),
      ));
      expect(raced.filter((s) => s === 200), `statuses ${raced.join(',')}`).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });

  test('an impersonation token used on A is refused on B', async () => {
    test.skip(!HA.jwtSecret, 'needs IT_HA_JWT_SECRET');
    const token = impersonationToken(HA_USERS.carol);
    const a = await client(A);
    const b = await client(B);
    try {
      const first = await a.get(`${A}/api/auth/impersonate?token=${token}`, { maxRedirects: 0 });
      // The rig's master user is a dummy: the first use gets past the replay
      // check and fails upstream (502). What matters is the second use.
      expect(first.status(), await first.text()).not.toBe(401);
      const second = await b.get(`${B}/api/auth/impersonate?token=${token}`, { maxRedirects: 0 });
      expect(second.status()).toBe(401);
      expect((await json<{ error: string }>(second)).error).toBe('Token already used');
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  test('a WOPI token revoked by signing out on C is refused on A and B', async () => {
    const cfg = await admin.patch(`${A}/api/admin/config`, { data: { wopiClientUrl: 'http://ha-wopi-stub/hosting/discovery' } });
    expect(cfg.ok(), await cfg.text()).toBe(true);
    const user = await client(A);
    try {
      await signIn(user, HA_USERS.bob, A);
      // A .docx-named blob in bob's account (the editor never opens it).
      const auth = 'Basic ' + Buffer.from(`${HA_USERS.bob}:${HA.password}`).toString('base64');
      const session = await (await fetch(`${HA.jmap}/jmap/session`, { headers: { Authorization: auth } })).json();
      const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
      const uploadUrl = String(session.uploadUrl).replace('{accountId}', accountId);
      const blob = await (await fetch(uploadUrl, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' }, body: 'not really a docx' })).json();
      await eventually(async () => (await fetch(`${A}/api/config`)).ok, 1000);
      const launch = await eventually(async () => {
        const res = await user.post(`${A}/api/wopi/launch`, { data: { blobId: blob.blobId, name: 'ha.docx', accountId } });
        return res.ok() ? json<{ url: string; accessToken: string }>(res) : null;
      }, SPREAD_MS * 2);
      const wopiSrc = new URL(launch.value.url).searchParams.get('WOPISrc')!;
      const docId = decodeURIComponent(wopiSrc).split('/').pop()!;
      const info = (origin: string) => fetch(`${origin}/api/wopi/files/${docId}?access_token=${encodeURIComponent(launch.value.accessToken)}`).then((r) => r.status);
      expect(await info(B)).toBe(200);
      const out = await user.delete(`${C}/api/auth/session?all=true`);
      expect(out.ok()).toBe(true);
      const { ms } = await eventually(async () => (await info(A)) === 401 && (await info(B)) === 401, SPREAD_MS + 2000);
      expect(ms).toBeLessThanOrEqual(SPREAD_MS);
    } finally {
      await admin.delete(`${A}/api/admin/config`, { data: { key: 'wopiClientUrl' } });
      await user.dispose();
    }
  });
});

test.describe('concurrent writes lose nothing', () => {
  test('settings saved through A load through B', async () => {
    const user = await client(A);
    await signIn(user, HA_USERS.alice, A);
    const marker = uniq('marker');
    try {
      const save = await user.post(`${A}/api/settings`, {
        data: { username: HA_USERS.alice, serverUrl: HA.jmap, settings: { haMarker: marker } },
      });
      expect(save.status(), await save.text()).toBe(200);
      const load = await user.get(`${B}/api/settings`, { headers: { 'x-settings-username': HA_USERS.alice, 'x-settings-server': HA.jmap } });
      expect(load.status()).toBe(200);
      expect((await json<{ settings: Record<string, unknown> }>(load)).settings?.haMarker).toBe(marker);
    } finally {
      await user.dispose();
    }
  });

  test('two replicas saving the same user\'s settings at once keep both templates', async () => {
    const user = await client(A);
    await signIn(user, HA_USERS.alice, A);
    const one = template('From A');
    const two = template('From B');
    try {
      const results = await Promise.all([
        user.post(`${A}/api/settings`, { data: { username: HA_USERS.alice, serverUrl: HA.jmap, settings: { templates: [one], deletedTemplateIds: {} } } }),
        user.post(`${B}/api/settings`, { data: { username: HA_USERS.alice, serverUrl: HA.jmap, settings: { templates: [two], deletedTemplateIds: {} } } }),
      ]);
      // Either both saved, or the loser was told (never a silent loss).
      const statuses = results.map((r) => r.status());
      const load = await user.get(`${C}/api/settings`, { headers: { 'x-settings-username': HA_USERS.alice, 'x-settings-server': HA.jmap } });
      const ids = ((await json<{ settings: { templates?: Array<{ id: string }> } }>(load)).settings?.templates ?? []).map((t) => t.id);
      for (const [i, t] of [one, two].entries()) {
        if (statuses[i] === 200) expect(ids, `template saved via ${i === 0 ? 'A' : 'B'} (status 200)`).toContain(t.id);
        else expect(statuses[i]).toBe(409);
      }
      expect(statuses).toContain(200);
    } finally {
      await user.dispose();
    }
  });

  test('two replicas storing plugin credentials for one user at once keep both', async () => {
    await withPlugins(async () => {
      const id = uniq('ha-secrets').toLowerCase();
      const install = await admin.post(`${A}/api/admin/plugins`, {
        multipart: { file: { name: `${id}.zip`, mimeType: 'application/zip', buffer: await pluginZip(id, { credentials: ['svc-a', 'svc-b'] }) } },
      });
      expect(install.ok(), await install.text()).toBe(true);
      const user = await client(A);
      await signIn(user, HA_USERS.carol, A);
      try {
        await eventually(async () => {
          const list = await json<{ plugins: Array<{ id: string }> }>(await user.get(`${B}/api/plugins`));
          return list.plugins.some((p) => p.id === id);
        }, SPREAD_MS * 2);
        const put = (origin: string, credentialId: string) => user.post(`${origin}/api/plugin-secrets`, {
          data: { pluginId: id, credentialId, label: credentialId, origin: 'https://api.example.org', inject: { type: 'bearer' }, secret: `s-${credentialId}` },
        });
        const results = await Promise.all([put(A, 'svc-a'), put(B, 'svc-b')]);
        expect(results.map((r) => r.status())).toEqual([200, 200]);
        const list = await json<{ credentials: Array<{ credentialId: string; connected: boolean }> }>(await user.get(`${C}/api/plugin-secrets?plugin=${id}`));
        expect(list.credentials.map((c) => c.credentialId).sort()).toEqual(['svc-a', 'svc-b']);
        expect(list.credentials.every((c) => c.connected)).toBe(true);
      } finally {
        await user.delete(`${A}/api/plugin-secrets?plugin=${id}`);
        await admin.delete(`${A}/api/admin/plugins`, { data: { id } });
        await user.dispose();
      }
    });
  });

  test('two admins saving different config keys on A and B at once keep both', async () => {
    const short = uniq('short');
    const description = uniq('description');
    try {
      const results = await Promise.all([
        admin.patch(`${A}/api/admin/config`, { data: { appShortName: short } }),
        admin.patch(`${B}/api/admin/config`, { data: { appDescription: description } }),
      ]);
      expect(results.map((r) => r.status())).toEqual([200, 200]);
      await eventually(async () => {
        const cfg = await json<Record<string, { value: unknown }>>(await admin.get(`${C}/api/admin/config`));
        return cfg.appShortName?.value === short && cfg.appDescription?.value === description;
      }, SPREAD_MS + 2000);
    } finally {
      await admin.delete(`${A}/api/admin/config`, { data: { key: 'appShortName' } });
      await admin.delete(`${A}/api/admin/config`, { data: { key: 'appDescription' } });
    }
  });

  test('audit entries written on all three replicas at once all end up in one log', async () => {
    const values = Array.from({ length: 30 }, (_, i) => `${uniq('audit')}-${i}`);
    try {
      const results = await Promise.all(values.map((value, i) =>
        admin.patch(`${HA.replicas[i % 3]}/api/admin/config`, { data: { appDescription: value } }),
      ));
      expect(results.every((r) => r.ok())).toBe(true);
      const { value: found } = await eventually(async () => {
        const log = await json<{ entries: Array<{ action: string; detail: { changes?: Array<{ key: string; new: unknown }> } }> }>(
          await admin.get(`${C}/api/admin/audit?action=config.update&limit=200`),
        );
        const seen = new Set(log.entries.flatMap((e) => (e.detail.changes ?? []).map((c) => String(c.new))));
        const missing = values.filter((v) => !seen.has(v));
        return missing.length === 0 ? seen : null;
      }, SPREAD_MS + 2000);
      expect(found.size).toBeGreaterThanOrEqual(30);
    } finally {
      await admin.delete(`${A}/api/admin/config`, { data: { key: 'appDescription' } });
    }
  });
});
