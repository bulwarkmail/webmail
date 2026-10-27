// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isStoredCredentialRefused,
  recordStoredCredentialStatus,
  resetStoredCredentialBudgetForTests,
} from '@/lib/stalwart/stored-credential-budget';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';

// A stale credential in a context cookie (password changed, app password
// revoked) was replayed to Stalwart on every call of the cookie-authed
// routes. Each call is a failed login from the webmail's address, and
// Stalwart's fail2ban then bans the webmail for everyone.

const basic = (user: string) => `Basic ${Buffer.from(`${user}:secret`).toString('base64')}`;
const MIN = 60 * 1000;

beforeEach(() => resetStoredCredentialBudgetForTests());

describe('stored credential budget', () => {
  it('refuses a credential for an hour after the server refused it', () => {
    const t0 = 1_000_000;
    recordStoredCredentialStatus(basic('a'), 401, t0);
    expect(isStoredCredentialRefused(basic('a'), t0 + 59 * MIN)).toBe(true);
    expect(isStoredCredentialRefused(basic('b'), t0 + 59 * MIN)).toBe(false);
    expect(isStoredCredentialRefused(basic('a'), t0 + 61 * MIN)).toBe(false);
  });

  it('past 20 failures in 15 minutes passes only credentials that worked in that time', () => {
    const t0 = 1_000_000;
    recordStoredCredentialStatus(basic('active'), 200, t0);
    recordStoredCredentialStatus(basic('idle'), 200, t0 - 20 * MIN);
    for (let i = 0; i < 19; i++) recordStoredCredentialStatus(basic(`stale-${i}`), 401, t0 + i);
    expect(isStoredCredentialRefused(basic('fresh'), t0 + MIN)).toBe(false);

    recordStoredCredentialStatus(basic('stale-19'), 401, t0 + MIN);
    expect(isStoredCredentialRefused(basic('fresh'), t0 + 2 * MIN)).toBe(true);
    expect(isStoredCredentialRefused(basic('idle'), t0 + 2 * MIN)).toBe(true);
    expect(isStoredCredentialRefused(basic('active'), t0 + 2 * MIN)).toBe(false);

    // The window ends 15 minutes after it started.
    expect(isStoredCredentialRefused(basic('fresh'), t0 + 16 * MIN)).toBe(false);
  });

  it('a successful sign-in lifts an earlier refusal of the same credential', () => {
    recordStoredCredentialStatus(basic('a'), 401, 1000);
    recordStoredCredentialStatus(basic('a'), 200, 2000);
    expect(isStoredCredentialRefused(basic('a'), 3000)).toBe(false);
  });

  it('leaves access tokens alone', () => {
    for (let i = 0; i < 30; i++) recordStoredCredentialStatus(`Bearer expired-${i}`, 401, 1000);
    expect(isStoredCredentialRefused('Bearer expired-0', 2000)).toBe(false);
    expect(isStoredCredentialRefused(basic('a'), 2000)).toBe(false);
  });
});

describe('fetchJmapServer with a stored credential', () => {
  const upstream = vi.fn(async () => new Response('', { status: 401 }));

  beforeEach(() => {
    upstream.mockClear();
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the mail server once and answers later calls with a stale credential itself', async () => {
    const init = { headers: { Authorization: basic('stale') } };
    const first = await fetchJmapServer('https://mail.example/jmap/session', init, true);
    const second = await fetchJmapServer('https://mail.example/jmap/', { ...init, method: 'POST', body: '{}' }, true);
    const third = await fetchJmapServer('https://mail.example/dav/file/', { headers: new Headers(init.headers) }, true);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps asking for a credential that works', async () => {
    upstream.mockImplementation(async () => new Response('{}', { status: 200 }));
    const init = { headers: { Authorization: basic('good') } };
    await fetchJmapServer('https://mail.example/jmap/session', init, true);
    await fetchJmapServer('https://mail.example/jmap/session', init, true);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
