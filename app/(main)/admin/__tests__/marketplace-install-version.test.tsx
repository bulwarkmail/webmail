import { beforeEach, describe, expect, it, vi } from 'vitest';

// A version older than the installed one comes back as 409 with a
// `downgrade` marker (the marketplace route). The admin is asked, like for
// a withdrawn version, and only then is the install repeated with `force`.

const calls: Array<{ body: Record<string, unknown> }> = [];
let responses: Response[] = [];
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
    return responses.shift() ?? new Response('{}', { status: 500 });
  }),
}));
vi.mock('next/link', () => ({ default: () => null }));

import { installVersion } from '../_pages/marketplace';

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
