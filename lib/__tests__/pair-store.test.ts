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

function newCode(grantId: string, now: number, owner = OWNER, base: string | null = BASE) {
  const pairing = createPairingCode(grantId, owner, base, now);
  if (!pairing) throw new Error('expected a code');
  return pairing;
}

beforeEach(() => {
  resetPairingStoreForTests();
});

describe('pairing store lifecycle', () => {
  it('issues a 256-bit code and a separate status id, and redeems the grant once', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    expect(isGrantAvailable(grantId, OWNER, T0)).toBe(true);

    const pairing = newCode(grantId, T0);
    expect(pairing.code).toMatch(/^[0-9a-f]{64}$/);
    expect(pairing.statusId).toMatch(/^[0-9a-f]{32}$/);
    expect(pairing.statusId).not.toBe(pairing.code.slice(0, 32));
    expect(pairing.expiresIn).toBe(CODE_TTL_MS / 1000);
    expect(getPairingStatus(pairing.statusId, T0 + 1)).toBe('pending');

    const redeemed = redeemPairingCode(pairing.code, T0 + 1000);
    expect(redeemed).toEqual({ ok: true, grant: GRANT, webmailBase: BASE });
    expect(getPairingStatus(pairing.statusId, T0 + 1001)).toBe('redeemed');

    // Single use.
    expect(redeemPairingCode(pairing.code, T0 + 2000)).toEqual({ ok: false, reason: 'used' });
    // ...and the grant is consumed: no new code for it, even within its window.
    expect(isGrantAvailable(grantId, OWNER, T0 + 2000)).toBe(false);
    expect(createPairingCode(grantId, OWNER, BASE, T0 + 2000)).toBeNull();
  });

  it('forgets the grant secrets once redeemed', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const pairing = newCode(grantId, T0);
    redeemPairingCode(pairing.code, T0 + 1);
    expect(internals().grants.get(grantId)?.grant).toBeNull();
  });

  it('issues a different code every time', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add(newCode(grantId, T0 + i).code);
    expect(codes.size).toBe(20);
  });

  it('answers invalid for a code nobody issued, and unknown for a status id nobody issued', () => {
    stashGrant(GRANT, OWNER, T0);
    expect(redeemPairingCode('0'.repeat(64), T0)).toEqual({ ok: false, reason: 'invalid' });
    expect(redeemPairingCode('', T0)).toEqual({ ok: false, reason: 'invalid' });
    expect(getPairingStatus('0'.repeat(32), T0)).toBe('unknown');
  });

  it('treats a code redeemed after its two minutes as expired', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const pairing = newCode(grantId, T0);

    expect(getPairingStatus(pairing.statusId, T0 + CODE_TTL_MS - 1)).toBe('pending');
    expect(getPairingStatus(pairing.statusId, T0 + CODE_TTL_MS)).toBe('expired');
    expect(redeemPairingCode(pairing.code, T0 + CODE_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    // The grant itself is still there for a new QR within its own window.
    expect(isGrantAvailable(grantId, OWNER, T0 + CODE_TTL_MS)).toBe(true);
    const next = newCode(grantId, T0 + CODE_TTL_MS);
    expect(redeemPairingCode(next.code, T0 + CODE_TTL_MS + 1)).toMatchObject({ ok: true });
  });

  it('supersedes the previous code of the same grant when a new one is shown', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const first = newCode(grantId, T0);
    const second = newCode(grantId, T0 + 1000);

    expect(getPairingStatus(first.statusId, T0 + 1001)).toBe('expired');
    expect(getPairingStatus(second.statusId, T0 + 1001)).toBe('pending');
    expect(redeemPairingCode(first.code, T0 + 1001)).toEqual({ ok: false, reason: 'expired' });

    // Only the QR on screen can be redeemed.
    expect(redeemPairingCode(second.code, T0 + 2000)).toMatchObject({ ok: true });
  });

  it('marks every other code of a redeemed grant used, and its status redeemed', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const first = newCode(grantId, T0);
    const second = newCode(grantId, T0 + 1000);
    expect(redeemPairingCode(second.code, T0 + 2000)).toMatchObject({ ok: true });

    expect(getPairingStatus(second.statusId, T0 + 2001)).toBe('redeemed');
    expect(getPairingStatus(first.statusId, T0 + 2001)).toBe('expired');
    // A late scan of the older QR is told it was already used, not expired.
    expect(redeemPairingCode(first.code, T0 + 2002)).toEqual({ ok: false, reason: 'used' });
    // ...even after its own two minutes ran out.
    expect(redeemPairingCode(first.code, T0 + CODE_TTL_MS + 5000)).toEqual({ ok: false, reason: 'used' });
  });

  it('keeps grants of different owners apart', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    expect(isGrantAvailable(grantId, '1:alice@example.org', T0)).toBe(false);
    expect(isGrantAvailable(grantId, '0:mallory@example.org', T0)).toBe(false);
    expect(createPairingCode(grantId, '1:alice@example.org', BASE, T0)).toBeNull();
    expect(createPairingCode(grantId, '0:mallory@example.org', BASE, T0)).toBeNull();
    expect(createPairingCode('f'.repeat(32), OWNER, BASE, T0)).toBeNull();
    // The rightful owner still can.
    expect(createPairingCode(grantId, OWNER, BASE, T0)).not.toBeNull();
  });

  it('wipes the grant secrets when the grant expires, keeping a tombstone', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    expect(isGrantAvailable(grantId, OWNER, T0 + GRANT_TTL_MS - 1)).toBe(true);

    expect(isGrantAvailable(grantId, OWNER, T0 + GRANT_TTL_MS)).toBe(false);
    expect(createPairingCode(grantId, OWNER, BASE, T0 + GRANT_TTL_MS)).toBeNull();
    const record = internals().grants.get(grantId);
    expect(record).toBeDefined();
    expect(record!.grant).toBeNull();
    expect(JSON.stringify(record)).not.toContain('access-1');
    expect(JSON.stringify(record)).not.toContain('refresh-1');

    // The tombstone goes too, eventually.
    stashGrant(GRANT, OWNER, T0 + GRANT_TTL_MS + TOMBSTONE_MS);
    expect(internals().grants.has(grantId)).toBe(false);
  });

  it('never lets a code outlive its grant', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const late = T0 + GRANT_TTL_MS - 30_000;
    const pairing = newCode(grantId, late);
    expect(pairing.expiresIn).toBe(30);

    expect(redeemPairingCode(pairing.code, T0 + GRANT_TTL_MS - 1)).toMatchObject({ ok: true });

    const other = stashGrant(GRANT, OWNER, T0);
    const code = newCode(other, late);
    expect(getPairingStatus(code.statusId, T0 + GRANT_TTL_MS)).toBe('expired');
    expect(redeemPairingCode(code.code, T0 + GRANT_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('stops the codes of a discarded grant', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const pairing = newCode(grantId, T0);
    discardGrant(grantId, T0 + 1);

    expect(isGrantAvailable(grantId, OWNER, T0 + 2)).toBe(false);
    expect(createPairingCode(grantId, OWNER, BASE, T0 + 2)).toBeNull();
    expect(redeemPairingCode(pairing.code, T0 + 2)).toEqual({ ok: false, reason: 'expired' });
    expect(internals().grants.get(grantId)?.grant).toBeNull();
  });

  it('remembers spent codes for status polls and late scans, then forgets them', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const pairing = newCode(grantId, T0);
    redeemPairingCode(pairing.code, T0 + 1);

    const forgetAt = T0 + CODE_TTL_MS + TOMBSTONE_MS;
    expect(getPairingStatus(pairing.statusId, forgetAt - 1)).toBe('redeemed');
    expect(redeemPairingCode(pairing.code, forgetAt - 1)).toEqual({ ok: false, reason: 'used' });

    expect(getPairingStatus(pairing.statusId, forgetAt)).toBe('unknown');
    expect(redeemPairingCode(pairing.code, forgetAt)).toEqual({ ok: false, reason: 'invalid' });
    expect(internals().codes.size).toBe(0);
    expect(internals().statusIndex.size).toBe(0);
  });

  it('hands out the webmail base the code was issued for', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const pairing = newCode(grantId, T0, OWNER, 'https://webmail.example/mail');
    expect(redeemPairingCode(pairing.code, T0 + 1)).toMatchObject({ ok: true, webmailBase: 'https://webmail.example/mail' });
  });

  it('forgets everything on reset', () => {
    const grantId = stashGrant(GRANT, OWNER, T0);
    const pairing = newCode(grantId, T0);
    resetPairingStoreForTests();
    expect(getPairingStatus(pairing.statusId, T0 + 1)).toBe('unknown');
    expect(redeemPairingCode(pairing.code, T0 + 1)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('pairing store instance', () => {
  it('is shared by every evaluation of the module (globalThis pinning)', async () => {
    const first = await import('@/lib/auth/pairing-store');
    const grantId = first.stashGrant(GRANT, OWNER, T0);
    const pairing = first.createPairingCode(grantId, OWNER, BASE, T0)!;

    vi.resetModules();
    const second = await import('@/lib/auth/pairing-store');
    expect(second).not.toBe(first);

    expect(second.isGrantAvailable(grantId, OWNER, T0 + 1)).toBe(true);
    expect(second.getPairingStatus(pairing.statusId, T0 + 1)).toBe('pending');
    expect(second.redeemPairingCode(pairing.code, T0 + 2)).toMatchObject({ ok: true, grant: GRANT });
    // The first instance sees the redemption made through the second.
    expect(first.getPairingStatus(pairing.statusId, T0 + 3)).toBe('redeemed');
    expect(first.redeemPairingCode(pairing.code, T0 + 3)).toEqual({ ok: false, reason: 'used' });
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

  it('hands a grant that dies unredeemed to the disposer, once', () => {
    const disposed: PairingGrant[] = [];
    registerGrantDisposer((g) => disposed.push(g));
    const discarded = stashGrant(APP_GRANT, OWNER, T0);
    discardGrant(discarded, T0 + 1);
    discardGrant(discarded, T0 + 2);
    const expired = stashGrant(APP_GRANT, OWNER, T0);
    isGrantAvailable(expired, OWNER, T0 + GRANT_TTL_MS + 1); // sweeps
    expect(disposed).toEqual([APP_GRANT, APP_GRANT]);
  });

  it('does not dispose of a redeemed grant', () => {
    const disposed: PairingGrant[] = [];
    registerGrantDisposer((g) => disposed.push(g));
    const id = stashGrant(APP_GRANT, OWNER, T0);
    expect(redeemPairingCode(newCode(id, T0).code, T0 + 1).ok).toBe(true);
    discardGrant(id, T0 + 2);
    isGrantAvailable(id, OWNER, T0 + GRANT_TTL_MS + 1);
    expect(disposed).toEqual([]);
  });

  it('keeps only the last few replaced codes of a grant', () => {
    const id = stashGrant(GRANT, OWNER, T0);
    const all = Array.from({ length: 50 }, (_, i) => newCode(id, T0 + i));
    expect(internals().codes.size).toBe(4);
    expect(internals().statusIndex.size).toBe(4);
    expect(getPairingStatus(all[49].statusId, T0 + 60)).toBe('pending');
    expect(getPairingStatus(all[48].statusId, T0 + 60)).toBe('expired');
    expect(getPairingStatus(all[0].statusId, T0 + 60)).toBe('unknown');
    expect(redeemPairingCode(all[0].code, T0 + 60)).toEqual({ ok: false, reason: 'invalid' });
  });
});
