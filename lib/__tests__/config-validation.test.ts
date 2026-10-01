import { describe, expect, it } from 'vitest';
import { isConfigData } from '@/lib/config-validation';
import { createConfig } from './fixtures/config';

const server = {
  id: 'primary',
  label: 'Primary mail server',
  url: 'https://mail.example.com',
  domains: ['example.com'],
};

describe('server configuration validation', () => {
  it('accepts a complete response without changing its values', () => {
    const config = createConfig();
    const before = structuredClone(config);

    expect(isConfigData(config)).toBe(true);
    expect(config).toEqual(before);
  });

  it('preserves empty strings, disabled flags and an empty server list', () => {
    const config = Object.fromEntries(Object.entries(createConfig()).map(([key, value]) => [
      key,
      typeof value === 'string' ? '' : typeof value === 'boolean' ? false : [],
    ]));

    expect(isConfigData(config)).toBe(true);
  });

  it('accepts a server list without a default URL and preserves OAuth and unknown fields', () => {
    const config = {
      ...createConfig({ jmapServerUrl: '', jmapServerAutoPickByDomain: true, oauthEnabled: true, oauthOnly: true }),
      jmapServers: [
        server,
        { ...server, id: 'secondary', domains: [], oauth: { clientId: 'webmail', issuerUrl: 'https://sso.example.com' }, futureServerOption: true },
      ],
      futureConfigOption: { enabled: true },
    };
    const before = structuredClone(config);

    expect(isConfigData(config)).toBe(true);
    expect(config).toEqual(before);
  });

  it.each([
    {},
    { clientId: 'webmail' },
    { issuerUrl: 'https://sso.example.com' },
    { clientId: '', issuerUrl: '' },
  ])('accepts optional public OAuth fields: %j', (oauth) => {
    expect(isConfigData(createConfig({ jmapServers: [{ ...server, oauth }] }))).toBe(true);
  });

  it.each([null, undefined, false, 1, 'config', [], {}].map((value) => ({ value })))('rejects a non-configuration response: $value', ({ value }) => {
    expect(isConfigData(value)).toBe(false);
  });

  it('rejects a partial response containing only the app name and server URL', () => {
    expect(isConfigData({ appName: 'Example Mail', jmapServerUrl: 'https://mail.example.com' })).toBe(false);
  });

  it.each(Object.keys(createConfig()))('rejects a response missing required field %s', (key) => {
    const config: Record<string, unknown> = { ...createConfig() };
    delete config[key];

    expect(isConfigData(config)).toBe(false);
  });

  it.each([
    ['appName', 42],
    ['jmapServerUrl', null],
    ['oauthEnabled', 'false'],
    ['oauthOnly', 0],
    ['oauthClientId', false],
    ['loginLogoLightUrl', {}],
    ['loginShowHeading', null],
    ['allowCustomJmapEndpoint', 'true'],
    ['parentOrigin', ['https://parent.example.com']],
  ])('rejects an incorrectly typed %s', (key, value) => {
    expect(isConfigData({ ...createConfig(), [key as string]: value })).toBe(false);
  });

  it.each([
    null,
    {},
    'servers',
    [null],
    ['primary'],
    [{ ...server, id: 1 }],
    [{ ...server, label: false }],
    [{ ...server, url: {} }],
    [{ ...server, domains: 'example.com' }],
    [{ ...server, domains: [1] }],
    [{ ...server, oauth: null }],
    [{ ...server, oauth: [] }],
    [{ ...server, oauth: 'oauth' }],
    [{ ...server, oauth: { clientId: false } }],
    [{ ...server, oauth: { issuerUrl: 42 } }],
  ].map((jmapServers) => ({ jmapServers })))('rejects malformed server entries: $jmapServers', ({ jmapServers }) => {
    expect(isConfigData({ ...createConfig(), jmapServers })).toBe(false);
  });

  it.each(['id', 'label', 'url', 'domains'])('rejects a server entry missing %s', (key) => {
    const entry: Record<string, unknown> = { ...server };
    delete entry[key];

    expect(isConfigData({ ...createConfig(), jmapServers: [entry] })).toBe(false);
  });
});
