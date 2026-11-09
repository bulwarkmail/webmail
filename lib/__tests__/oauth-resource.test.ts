import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/oauth/discovery', () => ({
  discoverOAuth: vi.fn(),
}));

vi.mock('@/lib/read-file-env', () => ({
  readFileEnv: () => '',
}));

const config = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    get: (key: string, def: unknown) => (config.values.has(key) ? config.values.get(key) : def),
    ensureLoaded: async () => {},
  },
}));

import { normalizeOauthResource, addOauthResource } from '@/lib/oauth/resource';
import { getOauthResource } from '@/lib/oauth/tokens';
import { getRequiredConfig } from '@/lib/oauth/token-exchange';

describe('normalizeOauthResource (#1461)', () => {
  it('keeps an absolute URI', () => {
    expect(normalizeOauthResource('https://mail.example.com')).toBe('https://mail.example.com');
    expect(normalizeOauthResource(' https://mail.example.com/jmap ')).toBe('https://mail.example.com/jmap');
    expect(normalizeOauthResource('urn:example:mail')).toBe('urn:example:mail');
  });

  it('drops values that cannot be resource indicators', () => {
    expect(normalizeOauthResource('')).toBeUndefined();
    expect(normalizeOauthResource('   ')).toBeUndefined();
    expect(normalizeOauthResource('mail.example.com')).toBeUndefined();
    expect(normalizeOauthResource('/jmap')).toBeUndefined();
    expect(normalizeOauthResource('https://mail.example.com/#api')).toBeUndefined();
    expect(normalizeOauthResource('https://mail.example.com#')).toBeUndefined();
    expect(normalizeOauthResource(undefined)).toBeUndefined();
    expect(normalizeOauthResource(42)).toBeUndefined();
  });
});

describe('addOauthResource (login page)', () => {
  const authUrl = () => new URL('https://idp.example.com/authorize?client_id=c');

  it('adds the resource for the global provider', () => {
    const url = authUrl();
    addOauthResource(url, 'https://mail.example.com', false);
    expect(url.searchParams.get('resource')).toBe('https://mail.example.com');
  });

  it('leaves it out for a server entry', () => {
    const url = authUrl();
    addOauthResource(url, 'https://mail.example.com', true);
    expect(url.searchParams.has('resource')).toBe(false);
  });

  it('leaves it out when unset or invalid', () => {
    for (const value of ['', 'not a uri', 'https://mail.example.com#x', undefined]) {
      const url = authUrl();
      addOauthResource(url, value, false);
      expect(url.searchParams.has('resource')).toBe(false);
    }
  });
});

describe('getRequiredConfig resource (#1461)', () => {
  beforeEach(() => {
    config.values.clear();
    config.values.set('jmapServers', [
      { id: 'mx2', label: 'Server 2', url: 'https://mx2.example.com' },
    ]);
    vi.stubEnv('JMAP_SERVER_URL', 'https://mail.example.com');
    vi.stubEnv('OAUTH_CLIENT_ID', 'client');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured resource for the global provider', () => {
    config.values.set('oauthResource', 'https://mail.example.com');
    expect(getOauthResource()).toBe('https://mail.example.com');
    expect(getRequiredConfig(null).resource).toBe('https://mail.example.com');
  });

  it('returns no resource for a server entry', () => {
    config.values.set('oauthResource', 'https://mail.example.com');
    expect(getRequiredConfig('mx2').resource).toBeUndefined();
  });

  it('returns no resource when unset or invalid', () => {
    expect(getRequiredConfig(null).resource).toBeUndefined();
    config.values.set('oauthResource', 'mail.example.com');
    expect(getOauthResource()).toBe('');
    expect(getRequiredConfig(null).resource).toBeUndefined();
  });
});
