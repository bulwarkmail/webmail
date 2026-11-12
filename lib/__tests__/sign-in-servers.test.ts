import { beforeEach, describe, expect, it, vi } from 'vitest';

// How many providers an instance signs users in at, from the settings the
// login page offers servers by. With one, a provider's metadata may name
// another issuer than the address discovery ran against; with more, it may
// not (lib/oauth/discovery.ts).

const state = vi.hoisted(() => ({ desktop: false, config: {} as Record<string, unknown> }));
vi.mock('@/lib/desktop/flag', () => ({
  get IS_DESKTOP_BUILD() { return state.desktop; },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    get: (key: string, fallback?: unknown) => (key in state.config ? state.config[key] : fallback),
  },
}));

import { hasSingleSignInServer, signInIssuerRule } from '@/lib/oauth/sign-in-servers';

const entry = (id: string, url: string, issuerUrl?: string) => ({ id, label: id, url, oauth: { clientId: 'webmail', ...(issuerUrl ? { issuerUrl } : {}) } });

beforeEach(() => {
  state.desktop = false;
  state.config = {};
  vi.unstubAllEnvs();
  vi.stubEnv('JMAP_SERVER_URL', '');
  vi.stubEnv('NEXT_PUBLIC_JMAP_SERVER_URL', '');
  vi.stubEnv('OAUTH_ISSUER_URL', '');
});

describe('the number of sign-in servers', () => {
  it('is one for one configured server, also by an internal address or from the environment', () => {
    state.config = { jmapServerUrl: 'http://stalwart:8080' };
    expect(hasSingleSignInServer()).toBe(true);
    expect(signInIssuerRule()).toBe('named');

    state.config = {};
    vi.stubEnv('JMAP_SERVER_URL', 'http://stalwart:8080');
    expect(hasSingleSignInServer()).toBe(true);
  });

  it('is one for a single listed server, and for one listed beside the same configured server', () => {
    state.config = { jmapServers: [entry('mail', 'https://mail.example')] };
    expect(hasSingleSignInServer()).toBe(true);

    state.config = { jmapServers: [entry('mail', 'https://mail.example')], jmapServerUrl: 'https://mail.example/' };
    expect(hasSingleSignInServer()).toBe(true);

    // The listed entry signs in at its own issuer, which the configured server shares.
    state.config = {
      jmapServers: [entry('mail', 'https://mail.example', 'https://id.example/realms/mail')],
      jmapServerUrl: 'http://stalwart:8080',
      oauthIssuerUrl: 'https://id.example/realms/mail',
    };
    expect(hasSingleSignInServer()).toBe(true);
  });

  it('is more than one for two listed servers', () => {
    state.config = { jmapServers: [entry('a', 'https://a.example'), entry('b', 'https://b.example')] };
    expect(hasSingleSignInServer()).toBe(false);
    expect(signInIssuerRule()).toBe('own');
  });

  it('is more than one for a listed server beside a configured server at another address', () => {
    state.config = { jmapServers: [entry('other', 'https://other.example')], jmapServerUrl: 'http://stalwart:8080' };
    expect(hasSingleSignInServer()).toBe(false);
  });

  it('is more than one for one listed server while users may type their own', () => {
    state.config = { jmapServers: [entry('mail', 'https://mail.example')], allowCustomJmapEndpoint: true };
    expect(hasSingleSignInServer()).toBe(false);
    state.config = { jmapServerUrl: 'https://mail.example', allowCustomJmapEndpoint: true };
    expect(hasSingleSignInServer()).toBe(false);
  });

  it('is more than one in the desktop build, whose users sign in to servers they typed', () => {
    state.desktop = true;
    state.config = { jmapServerUrl: 'https://mail.example' };
    expect(hasSingleSignInServer()).toBe(false);
    expect(signInIssuerRule()).toBe('own');
  });
});
