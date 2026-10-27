import { describe, expect, it } from 'vitest';
import { withProviderDataScopes } from '@/lib/oauth/scopes';

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
});
