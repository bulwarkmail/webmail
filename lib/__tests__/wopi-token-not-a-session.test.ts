import { describe, it, expect, vi } from 'vitest';
import { mintWopiToken, verifyWopiToken, wopiDocumentId } from '@/lib/wopi/token';
import { encryptPayload } from '@/lib/auth/crypto';
import {
  readStalwartAuthContextFromStore,
  setStalwartAuthContextInStore,
  stalwartAuthContextCookieName,
} from '@/lib/stalwart/auth-context';

// GHSA-cqqx-mjcf-mh55. The WOPI access token handed to the office editor and
// the jmap_stalwart_ctx session cookie are the same AES-256-GCM envelope under
// the same SESSION_SECRET-derived key. The editor token used to be accepted as
// a session context, which handed whoever held it - an editor log, a proxy
// access log - the user's whole mailbox through the JMAP passthrough, with the
// token's file scope and six-hour expiry both dropped on that path.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 'x'.repeat(32),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const CREDENTIALS = {
  serverUrl: 'https://mail.example.com',
  username: 'alice@example.org',
  authHeader: 'Basic YWxpY2U6czNjcmV0',
};

type CookieStore = Parameters<typeof readStalwartAuthContextFromStore>[0];

/** Minimal stand-in for the next/headers cookie store. */
function cookieStore(initial: Record<string, string> = {}): CookieStore {
  const jar = new Map(Object.entries(initial));
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  } as unknown as CookieStore;
}

describe('editor token presented as a session cookie', () => {
  const scope = {
    ...CREDENTIALS,
    accountId: 'c',
    fileId: 'd',
    canWrite: true,
    origin: 'https://mail.example.com',
  };
  const { token } = mintWopiToken(scope);

  it('is rejected by the session context reader', () => {
    const store = cookieStore({ [stalwartAuthContextCookieName(0)]: token });
    expect(readStalwartAuthContextFromStore(store, 0)).toBeNull();
  });

  it('is rejected even after base64url is decoded back to standard base64', () => {
    // The token is issued in the URL-safe alphabet; an attacker would be free
    // to convert it back before pasting it into the cookie.
    const standard = token.replace(/-/g, '+').replace(/_/g, '/');
    const store = cookieStore({ [stalwartAuthContextCookieName(0)]: standard });
    expect(readStalwartAuthContextFromStore(store, 0)).toBeNull();
  });

  it('still works for the file it was scoped to', () => {
    expect(verifyWopiToken(token, wopiDocumentId(scope))).toMatchObject({ fileId: 'd', username: CREDENTIALS.username });
    expect(verifyWopiToken(token, wopiDocumentId({ ...scope, fileId: 'other' }))).toBeNull();
  });
});

describe('session cookie presented as an editor token', () => {
  it('is rejected by the WOPI verifier', () => {
    const store = cookieStore();
    setStalwartAuthContextInStore(store, 0, CREDENTIALS);
    const sessionCookie = store.get(stalwartAuthContextCookieName(0))!.value;

    expect(verifyWopiToken(sessionCookie, 'd')).toBeNull();
  });

  it('round-trips on its own path', () => {
    const store = cookieStore();
    setStalwartAuthContextInStore(store, 0, CREDENTIALS);
    expect(readStalwartAuthContextFromStore(store, 0)).toEqual(CREDENTIALS);
  });
});

describe('pairing proof presented as a session cookie', () => {
  it('is rejected', () => {
    // Same shape lib/auth/pair-reauth.ts mints, without dragging next/headers
    // into the test.
    const proof = encryptPayload({ purpose: 'pair', created_at: Date.now() }, 'pair-reauth');
    const store = cookieStore({ [stalwartAuthContextCookieName(0)]: proof });
    expect(readStalwartAuthContextFromStore(store, 0)).toBeNull();
  });
});
