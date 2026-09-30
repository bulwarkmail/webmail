// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What a paired phone receives: the provider's own token endpoint when the
// app can talk to it directly (public client, a host the app accepts), else
// the webmail's token proxy with the refresh token sealed under
// SESSION_SECRET for the `pair-refresh` purpose.

let sessionSecret = 's'.repeat(64);
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => sessionSecret,
  hasSessionSecret: () => sessionSecret.length > 0,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import {
  PAIR_TOKEN_PROXY_PATH,
  appAcceptsTokenEndpoint,
  buildRedeemBundle,
  openPhoneRefreshToken,
  sealPhoneRefreshToken,
  type SealedRefresh,
} from '@/lib/auth/pair-bundle';
import { encryptPayload } from '@/lib/auth/crypto';
import type { PairingGrant } from '@/lib/auth/pairing-store';

const SERVER = 'https://mail.example.org';
const WEBMAIL = 'https://webmail.example.net/mail';
const NOW = 1_800_000_000_000;

function oauthGrant(overrides: Partial<Extract<PairingGrant, { flow: 'oauth' }>> = {}): PairingGrant {
  return {
    flow: 'oauth',
    serverUrl: SERVER,
    serverId: null,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    issuedAt: NOW,
    tokenEndpoint: `${SERVER}/auth/token`,
    clientId: 'bulwark-webmail',
    confidential: false,
    trusted: true,
    ...overrides,
  };
}

beforeEach(() => {
  sessionSecret = 's'.repeat(64);
});

describe('appAcceptsTokenEndpoint (mirror of the app rule)', () => {
  const cases: Array<[string, string, string, string | null, boolean]> = [
    ['same host as the JMAP server', `${SERVER}/auth/token`, SERVER, null, true],
    ['same host, other port', 'https://mail.example.org:8443/auth/token', SERVER, null, true],
    ['host case is ignored', 'HTTPS://MAIL.EXAMPLE.ORG/auth/token', SERVER, null, true],
    ['subdomain of the JMAP server', 'https://auth.mail.example.org/token', SERVER, null, true],
    ['parent domain of the JMAP server', 'https://example.org/token', SERVER, null, true],
    ['sibling subdomain', 'https://idp.example.org/token', SERVER, null, false],
    ['look-alike suffix', 'https://evilmail.example.org/token', SERVER, null, false],
    ['unrelated host', 'https://idp.example.com/token', SERVER, null, false],
    ['the webmail host', 'https://webmail.example.net/api/auth/pair/token', SERVER, WEBMAIL, true],
    ['subdomain of the webmail host', 'https://sso.webmail.example.net/token', SERVER, WEBMAIL, true],
    ['sibling of the webmail host', 'https://idp.example.net/token', SERVER, WEBMAIL, false],
    ['http on a public host', 'http://mail.example.org/auth/token', SERVER, null, false],
    ['http on localhost', 'http://localhost:8080/auth/token', 'http://localhost:8080', null, true],
    ['http on 127.0.0.1', 'http://127.0.0.1:8080/auth/token', 'http://127.0.0.1:8080', null, true],
    ['http on the Android emulator host', 'http://10.0.2.2:8080/auth/token', 'http://10.0.2.2:8080', null, true],
    ['http loopback, but not the server host', 'http://localhost:8080/auth/token', SERVER, null, false],
    ['other private http host', 'http://192.168.1.10/auth/token', 'http://192.168.1.10', null, false],
    ['not a URL', 'not a url', SERVER, null, false],
    ['other scheme', 'ftp://mail.example.org/token', SERVER, null, false],
  ];

  for (const [label, endpoint, server, webmail, expected] of cases) {
    it(`${expected ? 'accepts' : 'rejects'} ${label}`, () => {
      expect(appAcceptsTokenEndpoint(endpoint, server, webmail)).toBe(expected);
    });
  }
});

describe('buildRedeemBundle', () => {
  it('passes a password grant through as-is', () => {
    const bundle = buildRedeemBundle(
      { flow: 'password', serverUrl: SERVER, username: 'alice@example.org', password: 'app_x', credential: 'app-password' },
      WEBMAIL,
      NOW,
    );
    expect(bundle).toEqual({ flow: 'password', server_url: SERVER, username: 'alice@example.org', password: 'app_x' });
  });

  it('points a public client on the server host at the provider directly, with the raw refresh token', () => {
    const bundle = buildRedeemBundle(oauthGrant(), WEBMAIL, NOW);
    expect(bundle).toEqual({
      flow: 'oauth',
      server_url: SERVER,
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      token_endpoint: `${SERVER}/auth/token`,
      client_id: 'bulwark-webmail',
    });
  });

  it('reduces expires_in by the time elapsed since the tokens were issued', () => {
    expect(buildRedeemBundle(oauthGrant(), WEBMAIL, NOW + 100_900)).toMatchObject({ expires_in: 3500 });
    expect(buildRedeemBundle(oauthGrant({ expiresIn: 60 }), WEBMAIL, NOW + 120_000)).toMatchObject({ expires_in: 0 });
    expect(buildRedeemBundle(oauthGrant({ expiresIn: undefined }), WEBMAIL, NOW)).not.toHaveProperty('expires_in');
  });

  it('leaves out a refresh token the provider did not issue', () => {
    expect(buildRedeemBundle(oauthGrant({ refreshToken: undefined }), WEBMAIL, NOW)).not.toHaveProperty('refresh_token');
    expect(
      buildRedeemBundle(oauthGrant({ refreshToken: undefined, confidential: true }), WEBMAIL, NOW),
    ).not.toHaveProperty('refresh_token');
  });

  it('sends a confidential client through the webmail proxy with a sealed refresh token', () => {
    const grant = oauthGrant({ confidential: true, serverId: 'srv-1' });
    const bundle = buildRedeemBundle(grant, `${WEBMAIL}//`, NOW);
    expect(bundle.flow).toBe('oauth');
    if (bundle.flow !== 'oauth') return;
    expect(bundle.token_endpoint).toBe(`${WEBMAIL}${PAIR_TOKEN_PROXY_PATH}`);
    expect(bundle.client_id).toBe('bulwark-webmail');
    expect(bundle.access_token).toBe('access-1');
    expect(bundle.refresh_token).toBeDefined();
    expect(bundle.refresh_token).not.toContain('refresh-1');
    expect(openPhoneRefreshToken(bundle.refresh_token!)).toEqual({
      refreshToken: 'refresh-1',
      serverId: 'srv-1',
      clientId: 'bulwark-webmail',
      tokenEndpoint: `${SERVER}/auth/token`,
      trusted: true,
    });
  });

  it('proxies a public client whose token endpoint the app would refuse', () => {
    const grant = oauthGrant({ tokenEndpoint: 'https://idp.example.com/realms/x/token', clientId: 'webmail' });
    const bundle = buildRedeemBundle(grant, WEBMAIL, NOW);
    if (bundle.flow !== 'oauth') throw new Error('expected oauth');
    expect(bundle.token_endpoint).toBe(`${WEBMAIL}${PAIR_TOKEN_PROXY_PATH}`);
    expect(openPhoneRefreshToken(bundle.refresh_token!)).toMatchObject({
      refreshToken: 'refresh-1',
      tokenEndpoint: 'https://idp.example.com/realms/x/token',
      clientId: 'webmail',
    });
  });

  it('goes direct to an IdP on the webmail host family', () => {
    const grant = oauthGrant({ tokenEndpoint: 'https://sso.webmail.example.net/token' });
    const bundle = buildRedeemBundle(grant, WEBMAIL, NOW);
    expect(bundle).toMatchObject({ token_endpoint: 'https://sso.webmail.example.net/token', refresh_token: 'refresh-1' });
  });

  it('keeps the trust flag of a user-chosen server in the sealed token', () => {
    const bundle = buildRedeemBundle(oauthGrant({ confidential: true, trusted: false }), WEBMAIL, NOW);
    if (bundle.flow !== 'oauth') throw new Error('expected oauth');
    expect(openPhoneRefreshToken(bundle.refresh_token!)?.trusted).toBe(false);
  });
});

describe('sealed phone refresh tokens', () => {
  const VALUE: SealedRefresh = {
    refreshToken: 'refresh-1',
    serverId: null,
    clientId: 'bulwark-webmail',
    tokenEndpoint: `${SERVER}/auth/token`,
    trusted: true,
  };

  it('round-trip', () => {
    expect(openPhoneRefreshToken(sealPhoneRefreshToken(VALUE))).toEqual(VALUE);
    const other = { ...VALUE, serverId: 'srv-2', trusted: false };
    expect(openPhoneRefreshToken(sealPhoneRefreshToken(other))).toEqual(other);
  });

  it('are opaque', () => {
    const sealed = sealPhoneRefreshToken(VALUE);
    expect(sealed).not.toContain('refresh-1');
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain('refresh-1');
    expect(sealPhoneRefreshToken(VALUE)).not.toBe(sealed);
  });

  it('do not open from garbage, a tampered blob or an empty string', () => {
    expect(openPhoneRefreshToken('')).toBeNull();
    expect(openPhoneRefreshToken('garbage')).toBeNull();
    expect(openPhoneRefreshToken('refresh-1')).toBeNull();
    const sealed = Buffer.from(sealPhoneRefreshToken(VALUE), 'base64');
    sealed[sealed.length - 1] ^= 0x01;
    expect(openPhoneRefreshToken(sealed.toString('base64'))).toBeNull();
  });

  it('do not open from a blob sealed for another purpose', () => {
    const fields = { r: 'refresh-1', s: null, c: 'bulwark-webmail', e: `${SERVER}/auth/token`, t: true };
    expect(openPhoneRefreshToken(encryptPayload(fields, 'pair-reauth'))).toBeNull();
    expect(openPhoneRefreshToken(encryptPayload(fields, 'session-context'))).toBeNull();
    expect(openPhoneRefreshToken(encryptPayload(fields, 'sso-pending'))).toBeNull();
    // The same fields under the right purpose do open.
    expect(openPhoneRefreshToken(encryptPayload(fields, 'pair-refresh'))).toEqual(VALUE);
  });

  it('do not open under another SESSION_SECRET', () => {
    const sealed = sealPhoneRefreshToken(VALUE);
    sessionSecret = 't'.repeat(64);
    expect(openPhoneRefreshToken(sealed)).toBeNull();
  });

  it('reject payloads with missing or malformed fields', () => {
    const good = { r: 'refresh-1', s: null, c: 'bulwark-webmail', e: `${SERVER}/auth/token`, t: true };
    for (const bad of [
      { ...good, r: '' },
      { ...good, r: 1 },
      { ...good, c: '' },
      { ...good, e: '' },
      { ...good, s: 5 },
    ]) {
      expect(openPhoneRefreshToken(encryptPayload(bad, 'pair-refresh'))).toBeNull();
    }
    // Only an explicit `true` counts as trusted.
    expect(openPhoneRefreshToken(encryptPayload({ ...good, t: 'yes' }, 'pair-refresh'))?.trusted).toBe(false);
  });
});
