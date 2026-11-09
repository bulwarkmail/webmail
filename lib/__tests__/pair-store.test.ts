// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_TTL_MS,
  GRANT_TTL_MS,
  createPairingCode,
  discardGrant,
  getPairingStatus,
  isGrantAvailable,
  redeemPairingCode,
  registerGrantDisposer,
  resetPairingStoreForTests,
  stashGrant,
  type PairingGrant,
} from '@/lib/auth/pairing-store';

// The "Link mobile app" store: a step-up mints a grant (5 min), the desktop
// shows single-use codes for it (2 min each, a new one supersedes the old),
// and the phone redeems one code for the grant, exactly once. Spent records
// stay behind as tombstones without their secrets.

const OWNER = '0:alice@example.org';
const BASE = 'https://webmail.example';
const T0 = 1_800_000_000_000;
const TOMBSTONE_MS = 10 * 60 * 1000;

const GRANT: PairingGrant = {
  flow: 'oauth',
  serverUrl: 'https://mail.example.org',
  serverId: null,
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresIn: 3600,
  issuedAt: T0,
  tokenEndpoint: 'https://mail.example.org/auth/token',
  clientId: 'bulwark-webmail',
  confidential: false,
  trusted: true,
};

interface InternalStore {
  grants: Map<string, { grant: PairingGrant | null; expiresAt: number; owner: string; forgetAt: number }>;
  codes: Map<string, { grantId: string; state: string; expiresAt: number }>;
  statusIndex: Map<string, string>;
}

/** The pinned store itself, to check what is (not) kept in memory. */
function internals(): InternalStore {
  return (globalThis as unknown as { __bulwarkPairingStore: InternalStore }).__bulwarkPairingStore;
}

async function newCode(grantId: string, now: number, owner = OWNER, base: string | null = BASE) {
  const pairing = await createPairingCode(grantId, owner, base, now);
  if (!pairing) throw new Error('expected a code');
  return pairing;
}

beforeEach(() => {
  resetPairingStoreForTests();
});

describe('pairing store lifecycle', () => {
  it('issues a 256-bit code and a separate status id, and redeems the grant once', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    expect(await isGrantAvailable(grantId, OWNER, T0)).toBe(true);

    const pairing = await newCode(grantId, T0);
    expect(pairing.code).toMatch(/^[0-9a-f]{64}$/);
    expect(pairing.statusId).toMatch(/^[0-9a-f]{32}$/);
    expect(pairing.statusId).not.toBe(pairing.code.slice(0, 32));
    expect(pairing.expiresIn).toBe(CODE_TTL_MS / 1000);
    expect(await getPairingStatus(pairing.statusId, T0 + 1)).toBe('pending');

    const redeemed = await redeemPairingCode(pairing.code, T0 + 1000);
    expect(redeemed).toEqual({ ok: true, grant: GRANT, webmailBase: BASE });
    expect(await getPairingStatus(pairing.statusId, T0 + 1001)).toBe('redeemed');

    // Single use.
    expect(await redeemPairingCode(pairing.code, T0 + 2000)).toEqual({ ok: false, reason: 'used' });
    // ...and the grant is consumed: no new code for it, even within its window.
    expect(await isGrantAvailable(grantId, OWNER, T0 + 2000)).toBe(false);
    expect(await createPairingCode(grantId, OWNER, BASE, T0 + 2000)).toBeNull();
  });

  it('forgets the grant secrets once redeemed', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const pairing = await newCode(grantId, T0);
    await redeemPairingCode(pairing.code, T0 + 1);
    expect(internals().grants.get(grantId)?.grant).toBeNull();
  });

  it('issues a different code every time', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await newCode(grantId, T0 + i)).code);
    expect(codes.size).toBe(20);
  });

  it('answers invalid for a code nobody issued, and unknown for a status id nobody issued', async () => {
    await stashGrant(GRANT, OWNER, T0);
    expect(await redeemPairingCode('0'.repeat(64), T0)).toEqual({ ok: false, reason: 'invalid' });
    expect(await redeemPairingCode('', T0)).toEqual({ ok: false, reason: 'invalid' });
    expect(await getPairingStatus('0'.repeat(32), T0)).toBe('unknown');
  });

  it('treats a code redeemed after its two minutes as expired', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const pairing = await newCode(grantId, T0);

    expect(await getPairingStatus(pairing.statusId, T0 + CODE_TTL_MS - 1)).toBe('pending');
    expect(await getPairingStatus(pairing.statusId, T0 + CODE_TTL_MS)).toBe('expired');
    expect(await redeemPairingCode(pairing.code, T0 + CODE_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    // The grant itself is still there for a new QR within its own window.
    expect(await isGrantAvailable(grantId, OWNER, T0 + CODE_TTL_MS)).toBe(true);
    const next = await newCode(grantId, T0 + CODE_TTL_MS);
    expect(await redeemPairingCode(next.code, T0 + CODE_TTL_MS + 1)).toMatchObject({ ok: true });
  });

  it('supersedes the previous code of the same grant when a new one is shown', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const first = await newCode(grantId, T0);
    const second = await newCode(grantId, T0 + 1000);

    expect(await getPairingStatus(first.statusId, T0 + 1001)).toBe('expired');
    expect(await getPairingStatus(second.statusId, T0 + 1001)).toBe('pending');
    expect(await redeemPairingCode(first.code, T0 + 1001)).toEqual({ ok: false, reason: 'expired' });

    // Only the QR on screen can be redeemed.
    expect(await redeemPairingCode(second.code, T0 + 2000)).toMatchObject({ ok: true });
  });

  it('marks every other code of a redeemed grant used, and its status redeemed', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const first = await newCode(grantId, T0);
    const second = await newCode(grantId, T0 + 1000);
    expect(await redeemPairingCode(second.code, T0 + 2000)).toMatchObject({ ok: true });

    expect(await getPairingStatus(second.statusId, T0 + 2001)).toBe('redeemed');
    expect(await getPairingStatus(first.statusId, T0 + 2001)).toBe('expired');
    // A late scan of the older QR is told it was already used, not expired.
    expect(await redeemPairingCode(first.code, T0 + 2002)).toEqual({ ok: false, reason: 'used' });
    // ...even after its own two minutes ran out.
    expect(await redeemPairingCode(first.code, T0 + CODE_TTL_MS + 5000)).toEqual({ ok: false, reason: 'used' });
  });

  it('keeps grants of different owners apart', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    expect(await isGrantAvailable(grantId, '1:alice@example.org', T0)).toBe(false);
    expect(await isGrantAvailable(grantId, '0:mallory@example.org', T0)).toBe(false);
    expect(await createPairingCode(grantId, '1:alice@example.org', BASE, T0)).toBeNull();
    expect(await createPairingCode(grantId, '0:mallory@example.org', BASE, T0)).toBeNull();
    expect(await createPairingCode('f'.repeat(32), OWNER, BASE, T0)).toBeNull();
    // The rightful owner still can.
    expect(await createPairingCode(grantId, OWNER, BASE, T0)).not.toBeNull();
  });

  it('wipes the grant secrets when the grant expires, keeping a tombstone', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    expect(await isGrantAvailable(grantId, OWNER, T0 + GRANT_TTL_MS - 1)).toBe(true);

    expect(await isGrantAvailable(grantId, OWNER, T0 + GRANT_TTL_MS)).toBe(false);
    expect(await createPairingCode(grantId, OWNER, BASE, T0 + GRANT_TTL_MS)).toBeNull();
    const record = internals().grants.get(grantId);
    expect(record).toBeDefined();
    expect(record!.grant).toBeNull();
    expect(JSON.stringify(record)).not.toContain('access-1');
    expect(JSON.stringify(record)).not.toContain('refresh-1');

    // The tombstone goes too, eventually.
    await stashGrant(GRANT, OWNER, T0 + GRANT_TTL_MS + TOMBSTONE_MS);
    expect(internals().grants.has(grantId)).toBe(false);
  });

  it('never lets a code outlive its grant', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const late = T0 + GRANT_TTL_MS - 30_000;
    const pairing = await newCode(grantId, late);
    expect(pairing.expiresIn).toBe(30);

    expect(await redeemPairingCode(pairing.code, T0 + GRANT_TTL_MS - 1)).toMatchObject({ ok: true });

    const other = await stashGrant(GRANT, OWNER, T0);
    const code = await newCode(other, late);
    expect(await getPairingStatus(code.statusId, T0 + GRANT_TTL_MS)).toBe('expired');
    expect(await redeemPairingCode(code.code, T0 + GRANT_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('stops the codes of a discarded grant', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const pairing = await newCode(grantId, T0);
    await discardGrant(grantId, T0 + 1);

    expect(await isGrantAvailable(grantId, OWNER, T0 + 2)).toBe(false);
    expect(await createPairingCode(grantId, OWNER, BASE, T0 + 2)).toBeNull();
    expect(await redeemPairingCode(pairing.code, T0 + 2)).toEqual({ ok: false, reason: 'expired' });
    expect(internals().grants.get(grantId)?.grant).toBeNull();
  });

  it('remembers spent codes for status polls and late scans, then forgets them', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const pairing = await newCode(grantId, T0);
    await redeemPairingCode(pairing.code, T0 + 1);

    const forgetAt = T0 + CODE_TTL_MS + TOMBSTONE_MS;
    expect(await getPairingStatus(pairing.statusId, forgetAt - 1)).toBe('redeemed');
    expect(await redeemPairingCode(pairing.code, forgetAt - 1)).toEqual({ ok: false, reason: 'used' });

    expect(await getPairingStatus(pairing.statusId, forgetAt)).toBe('unknown');
    expect(await redeemPairingCode(pairing.code, forgetAt)).toEqual({ ok: false, reason: 'invalid' });
    expect(internals().codes.size).toBe(0);
    expect(internals().statusIndex.size).toBe(0);
  });

  it('hands out the webmail base the code was issued for', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const pairing = await newCode(grantId, T0, OWNER, 'https://webmail.example/mail');
    expect(await redeemPairingCode(pairing.code, T0 + 1)).toMatchObject({ ok: true, webmailBase: 'https://webmail.example/mail' });
  });

  it('forgets everything on reset', async () => {
    const grantId = await stashGrant(GRANT, OWNER, T0);
    const pairing = await newCode(grantId, T0);
    resetPairingStoreForTests();
    expect(await getPairingStatus(pairing.statusId, T0 + 1)).toBe('unknown');
    expect(await redeemPairingCode(pairing.code, T0 + 1)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('pairing store instance', () => {
  it('is shared by every evaluation of the module (globalThis pinning)', async () => {
    const first = await import('@/lib/auth/pairing-store');
    const grantId = await first.stashGrant(GRANT, OWNER, T0);
    const pairing = (await first.createPairingCode(grantId, OWNER, BASE, T0))!;

    vi.resetModules();
    const second = await import('@/lib/auth/pairing-store');
    expect(second).not.toBe(first);

    expect(await second.isGrantAvailable(grantId, OWNER, T0 + 1)).toBe(true);
    expect(await second.getPairingStatus(pairing.statusId, T0 + 1)).toBe('pending');
    expect(await second.redeemPairingCode(pairing.code, T0 + 2)).toMatchObject({ ok: true, grant: GRANT });
    // The first instance sees the redemption made through the second.
    expect(await first.getPairingStatus(pairing.statusId, T0 + 3)).toBe('redeemed');
    expect(await first.redeemPairingCode(pairing.code, T0 + 3)).toEqual({ ok: false, reason: 'used' });
  });
});

describe('pairing store after the security review', () => {
  const APP_GRANT: PairingGrant = {
    flow: 'password',
    serverUrl: 'https://mail.example.org',
    username: 'alice@example.org',
    password: 'app_secret',
    credential: 'app-password',
    appPasswordId: 'ap-1',
  };

  it('hands a grant that dies unredeemed to the disposer, once', async () => {
    const disposed: PairingGrant[] = [];
    registerGrantDisposer((g) => disposed.push(g));
    const discarded = await stashGrant(APP_GRANT, OWNER, T0);
    await discardGrant(discarded, T0 + 1);
    await discardGrant(discarded, T0 + 2);
    const expired = await stashGrant(APP_GRANT, OWNER, T0);
    await isGrantAvailable(expired, OWNER, T0 + GRANT_TTL_MS + 1); // sweeps
    expect(disposed).toEqual([APP_GRANT, APP_GRANT]);
  });

  it('does not dispose of a redeemed grant', async () => {
    const disposed: PairingGrant[] = [];
    registerGrantDisposer((g) => disposed.push(g));
    const id = await stashGrant(APP_GRANT, OWNER, T0);
    expect((await redeemPairingCode((await newCode(id, T0)).code, T0 + 1)).ok).toBe(true);
    await discardGrant(id, T0 + 2);
    await isGrantAvailable(id, OWNER, T0 + GRANT_TTL_MS + 1);
    expect(disposed).toEqual([]);
  });

  it('keeps only the last few replaced codes of a grant', async () => {
    const id = await stashGrant(GRANT, OWNER, T0);
    const all = await Promise.all(Array.from({ length: 50 }, (_, i) => newCode(id, T0 + i)));
    expect(internals().codes.size).toBe(4);
    expect(internals().statusIndex.size).toBe(4);
    expect(await getPairingStatus(all[49].statusId, T0 + 60)).toBe('pending');
    expect(await getPairingStatus(all[48].statusId, T0 + 60)).toBe('expired');
    expect(await getPairingStatus(all[0].statusId, T0 + 60)).toBe('unknown');
    expect(await redeemPairingCode(all[0].code, T0 + 60)).toEqual({ ok: false, reason: 'invalid' });
  });
});
