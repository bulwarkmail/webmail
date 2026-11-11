import { describe, it, expect } from 'vitest';
import { oauthSetupSuccessMessage } from '../oauth-setup-message';

const RESULT = {
  action: 'created',
  issuerUrl: 'https://mail.example.org',
  origin: 'https://webmail.example.org',
  redirectUriCount: 32,
  mobileClient: 'created',
  mobileClientId: 'bulwark-mobile',
  mobileRedirectUri: 'org.bulwarkmail.mobile:/auth/callback',
  stalwartScopes: ['urn:stalwart:oauth:scope:full'],
};

describe('oauthSetupSuccessMessage', () => {
  it('says that everyone has to sign in again (#1611)', () => {
    // Sessions from before can't renew their tokens, which otherwise looks
    // like something broke.
    expect(oauthSetupSuccessMessage(RESULT)).toMatch(/Everyone who is signed in has to sign in again\.$/);
    expect(oauthSetupSuccessMessage({ ...RESULT, action: 'updated', mobileClient: 'skipped', stalwartScopes: [] }))
      .toMatch(/has to sign in again/);
  });

  it('names the clients it set up', () => {
    const text = oauthSetupSuccessMessage(RESULT);
    expect(text).toContain('OAuth client created on Stalwart (https://mail.example.org).');
    expect(text).toContain('32 redirect URI(s) registered for https://webmail.example.org.');
    expect(text).toContain('Bulwark Mobile client created (bulwark-mobile, org.bulwarkmail.mobile:/auth/callback).');
    expect(text).not.toContain('Only a Stalwart superuser');
  });

  it('says when the client got less than full access', () => {
    const text = oauthSetupSuccessMessage({
      ...RESULT,
      stalwartScopes: ['urn:stalwart:oauth:scope:security', 'urn:stalwart:oauth:scope:settings'],
    });
    expect(text).toContain('Only a Stalwart superuser can allow full access');
  });
});
