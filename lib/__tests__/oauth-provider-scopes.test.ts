import { describe, expect, it } from 'vitest';
import { withProviderDataScopes, withStalwartScopes } from '@/lib/oauth/scopes';

// Stalwart 1.0 as the identity provider refuses a client it doesn't treat as
// first-party when the request names a scope it doesn't know ("openid email
// profile" -> invalid_scope), and gives that client only the data the granted
// scopes name. These are the scopes_supported both servers advertise live.

const STALWART_1_0 = [
  'openid',
  'offline_access',
  'urn:ietf:params:oauth:scope:mail',
  'urn:ietf:params:oauth:scope:contacts',
  'urn:ietf:params:oauth:scope:calendars',
  'urn:ietf:params:oauth:scope:files',
];
const STALWART_0_16 = STALWART_1_0.slice(0, 5);
const KEYCLOAK = ['openid', 'email', 'profile', 'offline_access', 'roles'];
const FULL = 'urn:stalwart:oauth:scope:full';
const SECURITY = 'urn:stalwart:oauth:scope:security';
const SETTINGS = 'urn:stalwart:oauth:scope:settings';

describe('withProviderDataScopes', () => {
  it('asks Stalwart 1.0 for its data scopes instead of scopes it does not know', () => {
    expect(withProviderDataScopes('openid email profile', STALWART_1_0)).toBe(
      'openid urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts '
        + 'urn:ietf:params:oauth:scope:calendars urn:ietf:params:oauth:scope:files',
    );
  });

  it('keeps scopes the provider lists', () => {
    expect(withProviderDataScopes('openid offline_access', STALWART_0_16)).toBe(
      'openid offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts '
        + 'urn:ietf:params:oauth:scope:calendars',
    );
  });

  it('leaves other providers alone', () => {
    expect(withProviderDataScopes('openid email profile', KEYCLOAK)).toBe('openid email profile');
    expect(withProviderDataScopes('openid email profile', undefined)).toBe('openid email profile');
  });

  // The configured scopes are shared by every server; Auto-configure on a
  // 1.0.3 server writes `full` there, and a second server's own provider must
  // not be asked for it.
  it("drops Stalwart's own scopes for a provider that doesn't list them", () => {
    expect(withProviderDataScopes(`openid ${FULL} email`, KEYCLOAK)).toBe('openid email');
    expect(withProviderDataScopes(`openid ${SECURITY}`, undefined)).toBe('openid');
  });

  // 1.0.3 lists its own scopes for every client and fails the request with
  // invalid_scope when it names one the client isn't allowed (#1527).
  const STALWART_1_0_3 = [...STALWART_1_0, FULL, SECURITY, SETTINGS];

  it('never asks Stalwart 1.0.3 for its own scopes just because it lists them', () => {
    expect(withProviderDataScopes('openid email profile', STALWART_1_0_3).split(' '))
      .not.toEqual(expect.arrayContaining([expect.stringMatching(/^urn:stalwart:/)]));
  });

  // Pocket ID grants an API's scopes per resource and lists only its own in
  // scopes_supported (#1583).
  describe('a request that names the mail server as its resource', () => {
    const POCKET_ID = ['openid', 'profile', 'email', 'groups', 'offline_access'];
    const MAIL = 'urn:ietf:params:oauth:scope:mail';

    it('sends the configured Stalwart scopes although the provider does not list them', () => {
      expect(withProviderDataScopes(`openid email profile ${MAIL} ${SECURITY} ${SETTINGS} ${FULL}`, POCKET_ID, true))
        .toBe(`openid email profile ${MAIL} ${SECURITY} ${SETTINGS} ${FULL}`);
      expect(withProviderDataScopes(`openid ${FULL}`, undefined, true)).toBe(`openid ${FULL}`);
    });

    it('still drops them without a resource', () => {
      expect(withProviderDataScopes(`openid email profile ${MAIL} ${SECURITY} ${SETTINGS} ${FULL}`, POCKET_ID))
        .toBe(`openid email profile ${MAIL}`);
    });

    it('adds none that is not configured', () => {
      expect(withProviderDataScopes('openid email profile', POCKET_ID, true)).toBe('openid email profile');
      expect(withProviderDataScopes('openid email profile', STALWART_1_0_3, true).split(' '))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^urn:stalwart:/)]));
    });
  });

  it('asks for a configured Stalwart scope only where the provider lists it', () => {
    expect(withProviderDataScopes(`openid ${FULL}`, STALWART_1_0_3).split(' ')).toContain(FULL);
    expect(withProviderDataScopes(`openid ${FULL}`, STALWART_1_0).split(' ')).not.toContain(FULL);
  });
});

describe('withStalwartScopes', () => {
  it('asks for exactly the Stalwart scopes the client was allowed', () => {
    expect(withStalwartScopes(`offline_access ${FULL}`, [SECURITY, SETTINGS])).toBe(
      `offline_access ${SECURITY} ${SETTINGS}`,
    );
    expect(withStalwartScopes('', [FULL])).toBe(FULL);
    expect(withStalwartScopes(`openid ${FULL}`, [FULL])).toBe(`openid ${FULL}`);
  });
});
