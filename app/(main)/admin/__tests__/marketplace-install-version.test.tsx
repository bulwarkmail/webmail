import { beforeEach, describe, expect, it, vi } from 'vitest';

// A version older than the installed one comes back as 409 with a
// `downgrade` marker (the marketplace route). The admin is asked, like for
// a withdrawn version, and only then is the install repeated with `force`.

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let responses: Response[] = [];
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return responses.shift() ?? new Response('{}', { status: 500 });
  }),
}));
vi.mock('next/link', () => ({ default: () => null }));

import { installVersion, rollbackVersion, withdrawnNote } from '../_pages/marketplace';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const BODY = { slug: 'jitsi-meet', version: '2.0.9', type: 'plugin' as const };

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

describe('installVersion', () => {
  it('asks before installing an older version and repeats with force when the admin agrees', async () => {
    responses = [json({ error: 'Version 2.0.9 is older than the installed 2.1.0.', downgrade: { installedVersion: '2.1.0' } }, 409), json({ warnings: [] })];
    const asked: string[] = [];
    const result = await installVersion(BODY, (q) => { asked.push(`${q.title} ${q.message}`); return true; });
    expect(asked).toEqual(['Install the older version anyway? Version 2.0.9 is older than the installed 2.1.0.']);
    expect(calls.map((c) => c.body.force)).toEqual([undefined, true]);
    expect(result.ok).toBe(true);
  });

  // The question is the page's ConfirmDialog, not window.confirm.
  it('waits for the answer of the page dialog', async () => {
    responses = [json({ error: 'withdrawn', yanked: { reason: null } }, 409), json({ warnings: [] })];
    const result = await installVersion(BODY, async (q) => q.title === 'Install it anyway?');
    expect(calls.map((c) => c.body.force)).toEqual([undefined, true]);
    expect(result.ok).toBe(true);
  });

  it('does not install an older version the admin declined', async () => {
    responses = [json({ error: 'older', downgrade: { installedVersion: '2.1.0' } }, 409)];
    const result = await installVersion(BODY, () => false);
    expect(result).toEqual({ ok: false, error: 'Not installed.' });
    expect(calls).toHaveLength(1);
  });

  it('says what an update adds, and repeats with what the admin saw', async () => {
    responses = [json({ error: 'adds', permissionsAdded: ['keystore'] }, 409), json({ warnings: [] })];
    const asked: string[] = [];
    const result = await installVersion(BODY, (q) => { asked.push(`${q.title} ${q.message}`); return true; });
    expect(asked[0]).toContain('new permissions');
    expect(asked[0]).toContain('keystore');
    expect(calls.map((c) => c.body.acceptPermissions)).toEqual([undefined, ['keystore']]);
    expect(calls.map((c) => c.body.force), 'not the same as forcing it').toEqual([undefined, undefined]);
    expect(result.ok).toBe(true);
  });

  it('on a first install, says the listing left them out', async () => {
    responses = [json({ error: 'unlisted', permissionsAdded: ['email:read'], compared: 'listing' }, 409), json({ warnings: [] })];
    const asked: string[] = [];
    const result = await installVersion(BODY, (q) => { asked.push(`${q.title} ${q.message} ${q.confirmText}`); return true; });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("listing did not show: email:read");
    expect(asked[0]).toContain('Install');
    expect(calls.map((c) => c.body.acceptPermissions)).toEqual([undefined, ['email:read']]);
    expect(result.ok).toBe(true);
  });

  it('sends what the page already showed, and asks only about the rest', async () => {
    responses = [json({ error: 'unlisted', permissionsAdded: ['email:read', 'email:send'], compared: 'listing' }, 409), json({ warnings: [] })];
    const asked: string[] = [];
    const result = await installVersion(BODY, (q) => { asked.push(q.message); return true; }, { shown: { permissions: ['email:read'] } });
    expect(calls[0].body.acceptPermissions).toEqual(['email:read']);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('email:send');
    expect(asked[0]).not.toContain('email:read');
    expect(calls.at(-1)!.body.acceptPermissions).toEqual(['email:read', 'email:send']);
    expect(result.ok).toBe(true);
  });

  it('names new hosts, paths, frame origins and full access, and sends back what the admin saw', async () => {
    const added = {
      permissions: [], httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/x'],
      frameOrigins: ['https://frames.example'], credentialOrigins: [], privileged: true,
    };
    responses = [json({ error: 'adds', permissionsAdded: [], grantsAdded: added, compared: 'installed' }, 409), json({ warnings: [] })];
    const asked: string[] = [];
    const result = await installVersion(BODY, (q) => { asked.push(q.message); return true; });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('May now contact https://collector.example.');
    expect(asked[0]).toContain('May now post to /api/x');
    expect(asked[0]).toContain('May now embed https://frames.example.');
    expect(asked[0]).toContain('Runs with full access to the app.');
    expect(calls.at(-1)!.body.acceptGrants).toEqual({
      httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/x'], frameOrigins: ['https://frames.example'], privileged: true,
    });
    expect(result.ok).toBe(true);
  });

  it('says what a skin does before a theme with one is installed', async () => {
    const skin = { permissions: [], httpOrigins: [], apiPostPaths: [], frameOrigins: [], credentialOrigins: [], privileged: false, skin: true };
    responses = [json({ error: 'skin', permissionsAdded: [], grantsAdded: skin, compared: 'listing' }, 409), json({ warnings: [] })];
    const asked: string[] = [];
    const result = await installVersion({ slug: 'bolt', version: '1.0.0', type: 'theme' }, (q) => { asked.push(`${q.title} ${q.message}`); return true; });
    expect(asked).toEqual(['Install a theme with a skin? bolt 1.0.0 comes with a skin. A theme with a skin restyles every part of the app, not only its colours.']);
    expect(calls.at(-1)!.body).toMatchObject({ acceptGrants: { skin: true } });
    expect(result.ok).toBe(true);
  });

  it('sends the frame origins a page showed with its permissions', async () => {
    responses = [json({ warnings: [] })];
    await installVersion(BODY, () => true, { shown: { permissions: ['email:read'], frameOrigins: ['https://meet.example'] } });
    expect(calls[0].body).toMatchObject({ acceptPermissions: ['email:read'], acceptGrants: { permissions: ['email:read'], frameOrigins: ['https://meet.example'] } });
  });

  it('answers a question with exactly what it listed', async () => {
    responses = [json({ error: 'unlisted', permissionsAdded: ['email:read', 'email:send'], compared: 'listing' }, 409), json({ warnings: [] })];
    await installVersion(BODY, () => true, { shown: { permissions: ['calendar:read', 'email:read'], frameOrigins: ['https://meet.example'] } });
    expect(calls[0].body.acceptPermissions).toEqual(['calendar:read', 'email:read']);
    expect(calls[1].body.acceptPermissions).toEqual(['email:read', 'email:send']);
    expect(calls[1].body.acceptGrants).toEqual({ permissions: ['email:read', 'email:send'] });
  });

  it('names a setting that stops being a secret, and sends it back as accepted', async () => {
    const grantsAdded = { permissions: [], httpOrigins: [], apiPostPaths: [], frameOrigins: [], credentialOrigins: [], credentials: [], formerSecrets: ['apiKey'], privileged: false, skin: false };
    responses = [json({ error: 'adds', permissionsAdded: [], grantsAdded, compared: 'installed' }, 409), json({ warnings: [] })];
    const asked: string[] = [];
    const result = await installVersion(BODY, (q) => { asked.push(q.message); return true; });
    expect(asked[0]).toContain('Stops keeping the setting "apiKey" secret');
    expect(asked[0]).toContain('The value stored so far stays sealed');
    expect(calls[1].body.acceptGrants).toEqual({ formerSecrets: ['apiKey'] });
    expect(result.ok).toBe(true);
  });

  it('asks only once about permissions, and shows a second refusal as an error', async () => {
    responses = [
      json({ error: 'adds', permissionsAdded: ['keystore'] }, 409),
      json({ error: 'adds more', permissionsAdded: ['keystore', 'email:send'] }, 409),
    ];
    const result = await installVersion(BODY, () => true);
    expect(result).toEqual({ ok: false, error: 'adds more' });
    expect(calls).toHaveLength(2);
  });

  it('does not update past new permissions the admin declined', async () => {
    responses = [json({ error: 'adds', permissionsAdded: ['keystore'] }, 409)];
    expect(await installVersion(BODY, () => false)).toEqual({ ok: false, error: 'Not installed.' });
    expect(calls).toHaveLength(1);
  });

  it('asks about both when a withdrawn version also adds permissions, and keeps both answers', async () => {
    responses = [
      json({ error: 'withdrawn', yanked: { reason: null } }, 409),
      json({ error: 'adds', permissionsAdded: ['keystore'] }, 409),
      json({ warnings: [] }),
    ];
    const asked: string[] = [];
    const result = await installVersion(BODY, (q) => { asked.push(q.title); return true; });
    expect(asked).toHaveLength(2);
    expect(calls.at(-1)!.body).toMatchObject({ force: true, acceptPermissions: ['keystore'] });
    expect(result.ok).toBe(true);
  });

  it('shows any other 409 as the error it is', async () => {
    responses = [json({ error: 'The configuration is read-only' }, 409)];
    const result = await installVersion(BODY, () => true);
    expect(result).toEqual({ ok: false, error: 'The configuration is read-only' });
    expect(calls).toHaveLength(1);
  });
});

describe('rollbackVersion', () => {
  const ROLLBACK = { kind: 'plugin' as const, id: 'pretty-dates', name: 'Pretty Dates', version: '1.0.0' };
  const added = { permissions: ['email:send'], httpOrigins: ['https://old.example'], apiPostPaths: [], frameOrigins: [], credentialOrigins: [], privileged: false, skin: false };

  it('says what comes back, and repeats with it accepted', async () => {
    responses = [json({ error: 'more', permissionsAdded: ['email:send'], grantsAdded: added, compared: 'rollback' }, 409), json({ success: true })];
    const asked: string[] = [];
    const result = await rollbackVersion(ROLLBACK, (q) => { asked.push(`${q.title} ${q.message}`); return true; });
    expect(result).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('brings back permissions');
    expect(asked[0]).toContain('email:send');
    expect(asked[0]).toContain('May now contact https://old.example.');
    expect(calls.map((c) => c.url)).toEqual(['/api/admin/extensions/plugin/pretty-dates/rollback', '/api/admin/extensions/plugin/pretty-dates/rollback']);
    expect(calls[0].body).toEqual({ version: '1.0.0' });
    expect(calls[1].body).toEqual({ version: '1.0.0', acceptPermissions: ['email:send'], acceptGrants: { permissions: ['email:send'], httpOrigins: ['https://old.example'] } });
  });

  it('does not roll back when the admin declines', async () => {
    responses = [json({ error: 'more', grantsAdded: added, compared: 'rollback' }, 409)];
    expect(await rollbackVersion(ROLLBACK, () => false)).toEqual({ ok: false, error: 'Not rolled back.' });
    expect(calls).toHaveLength(1);
  });

  it('names a skin coming back for a theme', async () => {
    responses = [json({ grantsAdded: { ...added, permissions: [], httpOrigins: [], skin: true }, compared: 'rollback' }, 409), json({ success: true })];
    const asked: string[] = [];
    await rollbackVersion({ ...ROLLBACK, kind: 'theme' }, (q) => { asked.push(q.message); return true; });
    expect(asked[0]).toContain('restyles every part of the app');
    expect(calls[1].body).toMatchObject({ acceptGrants: { skin: true } });
  });

  it('shows any other refusal as the error it is', async () => {
    responses = [json({ error: 'No kept copy of pretty-dates 1.0.0 on this server' }, 404)];
    expect(await rollbackVersion(ROLLBACK, () => true)).toEqual({ ok: false, error: 'No kept copy of pretty-dates 1.0.0 on this server' });
  });
});

describe('withdrawnNote', () => {
  it('names a version the directory had withdrawn, and one nobody knows about', () => {
    expect(withdrawnNote('1.0.0', { reason: 'breaks replies' })).toBe(' The directory had withdrawn v1.0.0 when it was installed: breaks replies');
    expect(withdrawnNote('1.0.0', { reason: null })).toBe(' The directory had withdrawn v1.0.0 when it was installed.');
    expect(withdrawnNote('1.0.0', 'unknown')).toMatch(/not known/);
    expect(withdrawnNote('1.0.0', undefined)).toBe('');
  });
});
