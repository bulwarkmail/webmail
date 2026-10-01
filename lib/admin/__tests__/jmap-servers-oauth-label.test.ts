import { describe, it, expect } from 'vitest';
import { offersOwnOAuth, parseJmapServers, redactJmapServers } from '@/lib/admin/jmap-servers';

describe('jmap server OAuth button label', () => {
  it('keeps a trimmed, bounded label with the OAuth settings and exposes it without the secret', () => {
    const parsed = parseJmapServers([
      {
        id: 'bridge',
        label: 'Bridge',
        url: 'https://bridge.example.com',
        oauth: { clientId: 'bulwark', clientSecret: 's3cret', buttonLabel: '  Sign in with Google  ' },
      },
      { id: 'long', label: 'Long', url: 'https://long.example.com', oauth: { clientId: 'x', buttonLabel: 'y'.repeat(200) } },
      // A label alone does not make a server an OAuth server.
      { id: 'label-only', label: 'Label only', url: 'https://mail.example.com', oauth: { buttonLabel: 'Sign in' } },
    ]);
    expect(parsed[0]!.oauth).toEqual({ clientId: 'bulwark', clientSecret: 's3cret', buttonLabel: 'Sign in with Google' });
    expect(parsed[1]!.oauth!.buttonLabel).toHaveLength(64);
    expect(parsed[2]!.oauth).toBeUndefined();

    const pub = redactJmapServers(parsed);
    expect(pub[0]!.oauth).toEqual({ clientId: 'bulwark', buttonLabel: 'Sign in with Google' });
  });

  it('offers a button of its own only for a client id with a label', () => {
    const server = (oauth?: { clientId?: string; buttonLabel?: string }) =>
      ({ id: 's', label: 'S', url: 'https://mail.example.com', domains: [], ...(oauth ? { oauth } : {}) });
    expect(offersOwnOAuth(server({ clientId: 'bridge', buttonLabel: 'Sign in with Google' }))).toBe(true);
    // A client id alone is the registered client for password and TOTP logins
    // (Stalwart's require_client_registration), not an OAuth sign-in.
    expect(offersOwnOAuth(server({ clientId: 'webmail' }))).toBe(false);
    expect(offersOwnOAuth(server({ buttonLabel: 'Sign in' }))).toBe(false);
    expect(offersOwnOAuth(server())).toBe(false);
    expect(offersOwnOAuth(undefined)).toBe(false);
  });
});
