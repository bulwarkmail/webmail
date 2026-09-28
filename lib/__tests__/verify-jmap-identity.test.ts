import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * verifyJmapIdentity binds a username claim to a verified credential
 * (GHSA-wxcm-j4jc-9fxq). The route-level behaviour for admin-configured
 * servers is covered in auth-routes-credential-check.test.ts; this file
 * covers the matching rules and the user-chosen (untrusted) endpoint path,
 * which must keep every hop on the rebinding-safe fetch.
 */

const lookup = vi.fn();
const guardedFetch = vi.fn();

vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return {
    ...actual,
    fetchPublicUrl: (...args: unknown[]) => guardedFetch(...args),
  };
});

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function load() {
  return import('@/lib/auth/verify-jmap-auth');
}

describe('usernameMatchesSession', () => {
  it('matches exact and case-different login names', async () => {
    const { usernameMatchesSession } = await load();
    expect(usernameMatchesSession('usera@example.org', 'usera@example.org')).toBe(true);
    expect(usernameMatchesSession('UserA@Example.org', 'usera@example.org')).toBe(true);
  });

  it('matches a bare local part against the canonical e-mail login on either side', async () => {
    const { usernameMatchesSession } = await load();
    expect(usernameMatchesSession('usera', 'usera@example.org')).toBe(true);
    expect(usernameMatchesSession('linus@example.org', 'linus')).toBe(true);
  });

  it('rejects different users, different domains and missing session usernames', async () => {
    const { usernameMatchesSession } = await load();
    expect(usernameMatchesSession('alice@example.org', 'mallory@example.org')).toBe(false);
    expect(usernameMatchesSession('alice@example.org', 'alice@other.example')).toBe(false);
    expect(usernameMatchesSession('alice', 'alicia@example.org')).toBe(false);
    expect(usernameMatchesSession('alice@example.org', undefined)).toBe(false);
    expect(usernameMatchesSession('alice@example.org', '')).toBe(false);
  });
});

describe('verifyJmapIdentity', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lookup.mockReset();
    guardedFetch.mockReset();
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('rejects an empty username before any fetch', async () => {
    const { verifyJmapIdentity } = await load();
    await expect(verifyJmapIdentity('https://example.com', 'Bearer x', '', { trusted: true }))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a Basic credential for another user before any fetch', async () => {
    const { verifyJmapIdentity } = await load();
    await expect(
      verifyJmapIdentity('https://example.com', basic('mallory@example.org', 'pw'), 'alice@example.org', { trusted: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces the upstream 401 for a Basic credential the server rejects', async () => {
    fetchSpy.mockResolvedValueOnce(json({ status: 401 }, 401));
    const { verifyJmapIdentity } = await load();
    await expect(
      verifyJmapIdentity('https://mail.internal', basic('alice@example.org', 'wrong'), 'alice@example.org', { trusted: true }),
    ).rejects.toMatchObject({ status: 401, upstreamStatus: 401 });
  });

  it('accepts a Basic credential the server accepts without inspecting Session.username', async () => {
    // Stalwart canonicalizes the login; a Basic caller who typed an alias is
    // still proven by the server accepting exactly that user:password pair.
    fetchSpy.mockResolvedValueOnce(json({ apiUrl: 'https://mail.internal/jmap/', username: 'alice', accounts: {} }));
    const { verifyJmapIdentity } = await load();
    await expect(
      verifyJmapIdentity('https://mail.internal/', basic('a.smith@example.org', 'pw'), 'a.smith@example.org', { trusted: true }),
    ).resolves.toBe('https://mail.internal');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('on a user-chosen endpoint, runs the identity lookup through the guarded fetch on the verified origin', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    guardedFetch
      .mockResolvedValueOnce(json({
        apiUrl: 'https://public.example.com:8443/jmap/',
        username: 'linus',
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' },
        accounts: {},
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['Identity/get', { accountId: 'c', list: [{ id: 'i0', email: 'Linus.Rath@example.com' }] }, '0']],
      }));
    const { verifyJmapIdentity } = await load();
    await expect(
      verifyJmapIdentity('https://example.com', 'Bearer tok', 'linus.rath@example.com', { trusted: false }),
    ).resolves.toBe('https://example.com');
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(guardedFetch).toHaveBeenLastCalledWith(
      'https://example.com/jmap/',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((guardedFetch.mock.calls[1][1] as { body: string }).body);
    expect(body.methodCalls[0][0]).toBe('Identity/get');
    expect(body.methodCalls[0][1]).toEqual({ accountId: 'c', ids: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a Bearer claim that neither Session.username nor any identity confirms', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({
        apiUrl: 'https://mail.internal/jmap/',
        username: 'mallory@example.org',
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' },
        accounts: {},
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['Identity/get', { accountId: 'c', list: [{ id: 'i0', email: 'mallory@example.org' }] }, '0']],
      }));
    const { verifyJmapIdentity } = await load();
    await expect(
      verifyJmapIdentity('https://mail.internal', 'Bearer tok', 'alice@example.org', { trusted: true }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a Bearer claim when the session has no primary mail account to look identities up on', async () => {
    fetchSpy.mockResolvedValueOnce(json({ apiUrl: 'https://mail.internal/jmap/', username: 'mallory', accounts: {} }));
    const { verifyJmapIdentity } = await load();
    await expect(
      verifyJmapIdentity('https://mail.internal', 'Bearer tok', 'alice@example.org', { trusted: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed Identity/get response as a failure, not as a match', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({
        apiUrl: 'https://mail.internal/jmap/',
        username: 'mallory',
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' },
        accounts: {},
      }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const { verifyJmapIdentity } = await load();
    await expect(
      verifyJmapIdentity('https://mail.internal', 'Bearer tok', 'alice@example.org', { trusted: true }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('resolveJmapIdentity account name', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('keys a bare Bearer claim on the canonical login, so john@b cannot become john', async () => {
    fetchSpy.mockResolvedValueOnce(json({ apiUrl: 'https://mail.internal/jmap/', username: 'john@b.example', accounts: {} }));
    const { resolveJmapIdentity } = await load();
    await expect(resolveJmapIdentity('https://mail.internal', 'Bearer tok', 'john', { trusted: true }))
      .resolves.toEqual({ serverUrl: 'https://mail.internal', accountName: 'john@b.example' });
  });

  it('keeps a fully-qualified Bearer claim as it is', async () => {
    fetchSpy.mockResolvedValueOnce(json({ apiUrl: 'https://mail.internal/jmap/', username: 'john@b.example', accounts: {} }));
    const { resolveJmapIdentity } = await load();
    await expect(resolveJmapIdentity('https://mail.internal', 'Bearer tok', 'John@B.example', { trusted: true }))
      .resolves.toEqual({ serverUrl: 'https://mail.internal', accountName: 'John@B.example' });
  });

  it('keeps a Basic claim as it is: the server accepted exactly that login', async () => {
    fetchSpy.mockResolvedValueOnce(json({ apiUrl: 'https://mail.internal/jmap/', username: 'john@a.example', accounts: {} }));
    const { resolveJmapIdentity } = await load();
    await expect(resolveJmapIdentity('https://mail.internal', basic('john', 'pw'), 'john', { trusted: true }))
      .resolves.toEqual({ serverUrl: 'https://mail.internal', accountName: 'john' });
  });
});
