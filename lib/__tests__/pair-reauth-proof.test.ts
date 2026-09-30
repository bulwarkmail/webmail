// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The pair_reauth cookie (lib/auth/pair-reauth.ts) remembers which pairing
// grant a step-up minted, for which signed-in account. Signing out
// (DELETE /api/auth/session) clears it and kills its grant, so a QR left on
// screen stops working - but only when it belongs to the account signing out.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string, _options?: Record<string, unknown>) => { jar.set(name, value); },
  delete: (arg: string | { name: string }) => { jar.delete(typeof arg === 'string' ? arg : arg.name); },
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
};
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: (_key: string, fallback: unknown) => fallback },
}));
vi.mock('@/lib/wopi/revocation', () => ({ revokeWopiTokens: async () => {} }));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import {
  clearPairReauthInStore,
  pairingOwner,
  readPairReauthFromStore,
  setPairReauthInStore,
} from '@/lib/auth/pair-reauth';
import {
  createPairingCode,
  isGrantAvailable,
  redeemPairingCode,
  resetPairingStoreForTests,
  stashGrant,
  type PairingGrant,
} from '@/lib/auth/pairing-store';
import { setStalwartAuthContextInStore } from '@/lib/stalwart/auth-context';
import { DELETE } from '@/app/api/auth/session/route';

type Store = Parameters<typeof setPairReauthInStore>[0];
const store = cookieStore as unknown as Store;
const WEBMAIL = 'https://webmail.example';

const GRANT: PairingGrant = {
  flow: 'password',
  serverUrl: 'https://mail.example.org',
  username: 'bob@example.org',
  password: 'app_secret',
  credential: 'app-password',
};

function stepUp(owner: string): string {
  const grantId = stashGrant(GRANT, owner);
  setPairReauthInStore(store, { grantId, owner });
  return grantId;
}

async function signOut(query: string) {
  const res = await DELETE(new NextRequest(`${WEBMAIL}/api/auth/session${query}`, {
    method: 'DELETE',
    headers: { 'sec-fetch-site': 'same-origin' },
  }));
  return res.status;
}

beforeEach(() => {
  jar.clear();
  resetPairingStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pair_reauth cookie', () => {
  it('names the owner by slot and normalized login', () => {
    expect(pairingOwner(3, '  Alice@Example.ORG ')).toBe('3:alice@example.org');
  });

  it('round-trips the grant and owner, and nothing else', () => {
    const grantId = stepUp('1:bob@example.org');
    expect(readPairReauthFromStore(store)).toEqual({ grantId, owner: '1:bob@example.org' });
    const opened = decryptPayload(jar.get('pair_reauth')!, 'pair-reauth');
    expect(Object.keys(opened!).sort()).toEqual(['created_at', 'grant_id', 'owner', 'p', 'purpose']);
    expect(JSON.stringify(opened)).not.toContain('app_secret');
  });

  it('expires after five minutes even if the cookie survives', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T10:00:00Z'));
    stepUp('0:bob@example.org');
    vi.setSystemTime(new Date('2026-09-27T10:04:59Z'));
    expect(readPairReauthFromStore(store)).not.toBeNull();
    vi.setSystemTime(new Date('2026-09-27T10:05:01Z'));
    expect(readPairReauthFromStore(store)).toBeNull();
  });

  it('fails closed for a proof from before grants existed', () => {
    jar.set('pair_reauth', encryptPayload({ purpose: 'pair', created_at: Date.now() }, 'pair-reauth'));
    expect(readPairReauthFromStore(store)).toBeNull();
  });

  it('does not accept a blob minted for another purpose', () => {
    const fields = { purpose: 'pair', created_at: Date.now(), grant_id: 'g', owner: '0:bob@example.org' };
    jar.set('pair_reauth', encryptPayload(fields, 'sso-pending'));
    expect(readPairReauthFromStore(store)).toBeNull();
    jar.set('pair_reauth', encryptPayload(fields, 'pair-refresh'));
    expect(readPairReauthFromStore(store)).toBeNull();
    jar.set('pair_reauth', 'garbage');
    expect(readPairReauthFromStore(store)).toBeNull();
  });

  it('kills the previous grant when a new step-up replaces it', () => {
    const first = stepUp('0:bob@example.org');
    const code = createPairingCode(first, '0:bob@example.org', WEBMAIL)!;
    const second = stepUp('0:bob@example.org');
    expect(isGrantAvailable(first, '0:bob@example.org')).toBe(false);
    expect(isGrantAvailable(second, '0:bob@example.org')).toBe(true);
    expect(redeemPairingCode(code.code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('keeps the grant when the same one is written again', () => {
    const grantId = stepUp('0:bob@example.org');
    setPairReauthInStore(store, { grantId, owner: '0:bob@example.org' });
    expect(isGrantAvailable(grantId, '0:bob@example.org')).toBe(true);
  });

  it('clears only a proof of the given slot', () => {
    const grantId = stepUp('1:bob@example.org');
    clearPairReauthInStore(store, 0);
    clearPairReauthInStore(store, 10);
    expect(jar.has('pair_reauth')).toBe(true);
    expect(isGrantAvailable(grantId, '1:bob@example.org')).toBe(true);

    clearPairReauthInStore(store, 1);
    expect(jar.has('pair_reauth')).toBe(false);
    expect(isGrantAvailable(grantId, '1:bob@example.org')).toBe(false);
  });

  it('clears an unreadable proof whatever the slot', () => {
    jar.set('pair_reauth', 'garbage');
    clearPairReauthInStore(store, 4);
    expect(jar.has('pair_reauth')).toBe(false);
  });
});

describe('DELETE /api/auth/session and the pairing proof', () => {
  beforeEach(() => {
    for (const slot of [0, 1]) {
      setStalwartAuthContextInStore(store as never, slot, {
        serverUrl: 'https://mail.example.org',
        username: slot === 0 ? 'alice@example.org' : 'bob@example.org',
        authHeader: 'Bearer t',
      });
    }
  });

  it("signing out of the proof's account clears it and kills its QR", async () => {
    const grantId = stepUp('1:bob@example.org');
    const code = createPairingCode(grantId, '1:bob@example.org', WEBMAIL)!;

    expect(await signOut('?slot=1')).toBe(200);
    expect(jar.has('pair_reauth')).toBe(false);
    expect(isGrantAvailable(grantId, '1:bob@example.org')).toBe(false);
    expect(createPairingCode(grantId, '1:bob@example.org', WEBMAIL)).toBeNull();
    expect(redeemPairingCode(code.code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('signing out of another account keeps it', async () => {
    const grantId = stepUp('1:bob@example.org');
    expect(await signOut('?slot=0')).toBe(200);
    expect(jar.has('pair_reauth')).toBe(true);
    expect(isGrantAvailable(grantId, '1:bob@example.org')).toBe(true);
    // The slot's own session is gone, the other one is not.
    expect(jar.has('jmap_stalwart_ctx')).toBe(false);
    expect(jar.has('jmap_stalwart_ctx_1')).toBe(true);
  });

  it('signing out without a slot means slot 0', async () => {
    const grantId = stepUp('0:alice@example.org');
    expect(await signOut('')).toBe(200);
    expect(jar.has('pair_reauth')).toBe(false);
    expect(isGrantAvailable(grantId, '0:alice@example.org')).toBe(false);
  });

  it('signing out of every account clears it', async () => {
    const grantId = stepUp('1:bob@example.org');
    expect(await signOut('?all=true')).toBe(200);
    expect(jar.has('pair_reauth')).toBe(false);
    expect(isGrantAvailable(grantId, '1:bob@example.org')).toBe(false);
  });

  it('leaves a phone that already paired alone', async () => {
    const grantId = stepUp('1:bob@example.org');
    const code = createPairingCode(grantId, '1:bob@example.org', WEBMAIL)!;
    expect(redeemPairingCode(code.code)).toMatchObject({ ok: true });
    expect(await signOut('?all=true')).toBe(200);
    // Nothing to revoke server-side: the phone holds its own credential.
    expect(redeemPairingCode(code.code)).toEqual({ ok: false, reason: 'used' });
  });

  it('refuses a cross-site sign-out and keeps the proof', async () => {
    const grantId = stepUp('1:bob@example.org');
    const res = await DELETE(new NextRequest(`${WEBMAIL}/api/auth/session?all=true`, {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    }));
    expect(res.status).toBe(403);
    expect(jar.has('pair_reauth')).toBe(true);
    expect(isGrantAvailable(grantId, '1:bob@example.org')).toBe(true);
  });
});
