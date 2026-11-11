/**
 * @vitest-environment node
 *
 * The header a credential puts its secret into comes from a list. A package
 * with another header is refused when it is installed, updated or put back
 * (plugin-credential-headers.test.ts). This file is about what is installed
 * already: a plugin saved before the list existed, and an account a user
 * connected then. For those no secret is put into a header outside the
 * list when a request is sent. The real proxy and the real vault; a local
 * server on 127.0.0.1 stands in for the service and answers with the request
 * id it was sent.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const registry = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPlugin: vi.fn(async (id: string) => registry.get(id) ?? null),
  getPluginRegistry: vi.fn(async () => ({ plugins: [...registry.values()] })),
}));
vi.mock('@/lib/admin/plugin-approvals', () => ({ listApprovals: async () => [] }));
const savedConfig = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-config', () => ({
  getPluginConfig: vi.fn(async (id: string) => savedConfig.get(id) ?? {}),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { proxyRequest, resetProxyLimits } from '@/lib/plugin-secrets/proxy';
import { putUserCredential } from '@/lib/plugin-secrets/vault';
import { CREDENTIAL_HEADER_NAMES, authHeaderFor, checkCredentials, checkInject, isCredentialHeader, unlistedCredentialHeaders } from '../plugin-secrets/credentials';

let server: http.Server;
let service: string;
/** Every header value the service was sent, in order. */
const received: string[] = [];
let vaultDir: string;
const user = { username: 'alice@example.org', serverUrl: 'https://mail.example.org' };
const FAKE = 'fake-key-for-the-test';

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-for-the-plugin-vault-0123456789';
  vaultDir = mkdtempSync(path.join(tmpdir(), 'rv3-vault-'));
  process.env.PLUGIN_SECRETS_DIR = vaultDir;
  server = http.createServer((req, res) => {
    received.push(...Object.values(req.headers).flat().filter((value): value is string => typeof value === 'string'));
    const id = req.headers['x-request-id'];
    res.writeHead(200, { 'content-type': 'application/json', ...(typeof id === 'string' ? { 'x-request-id': id } : {}) });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  service = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PLUGIN_PROXY_PRIVATE_ORIGINS = service;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(vaultDir, { recursive: true, force: true });
});
beforeEach(() => { registry.clear(); savedConfig.clear(); resetProxyLimits(); received.length = 0; });

/** What the plugin's code gets back from one request through the proxy. */
async function pluginReceives(credentialId: string): Promise<string | null> {
  const answer = await proxyRequest({ user, pluginId: 'notes', credentialId, url: `${service}/v1/me`, method: 'GET', headers: new Headers(), body: null });
  return answer.headers.get('x-request-id');
}

describe('what was installed or connected before the list existed', () => {
  it('control: a credential with a listed header gives the plugin nothing back', async () => {
    registry.set('notes', {
      id: 'notes', enabled: true, version: '1.0.0', permissions: ['http:proxy'],
      configSchema: { apiKey: { type: 'secret', label: 'Key' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: { type: 'header', name: 'X-API-Key' }, secretKey: 'apiKey', origin: service } },
    });
    savedConfig.set('notes', { apiKey: FAKE });
    expect(await pluginReceives('svc')).toBeNull();
  });

  it('a plugin in the registry whose credential names X-Request-Id: the stored key does not come back to the plugin', async () => {
    registry.set('notes', {
      id: 'notes', enabled: true, version: '1.0.0', permissions: ['http:proxy'],
      configSchema: { apiKey: { type: 'secret', label: 'Key' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: { type: 'header', name: 'X-Request-Id' }, secretKey: 'apiKey', origin: service } },
    });
    savedConfig.set('notes', { apiKey: FAKE });
    expect(await pluginReceives('svc')).toBeNull();
    // The request went out, without the key in any header.
    expect(received.length).toBeGreaterThan(0);
    expect(received.filter((value) => value.includes(FAKE))).toEqual([]);
  });

  it('an account a user connected with that header: the same', async () => {
    registry.set('notes', {
      id: 'notes', enabled: true, version: '1.0.0', permissions: ['http:proxy'],
      credentials: { cloud: { label: 'Cloud', scope: 'user', inject: { type: 'header', name: 'X-Request-Id' }, origin: service } },
    });
    await putUserCredential(user, 'notes', 'cloud', { origin: service, inject: { type: 'header', name: 'X-Request-Id' }, label: 'Cloud', secret: FAKE });
    expect(await pluginReceives('cloud')).toBeNull();
    expect(received.filter((value) => value.includes(FAKE))).toEqual([]);
  });

  it('control: with a listed header the key does reach the service, in that header only', async () => {
    registry.set('notes', {
      id: 'notes', enabled: true, version: '1.0.0', permissions: ['http:proxy'],
      configSchema: { apiKey: { type: 'secret', label: 'Key' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: { type: 'header', name: 'X-API-Key', prefix: 'Key ' }, secretKey: 'apiKey', origin: service } },
    });
    savedConfig.set('notes', { apiKey: FAKE });
    expect(await pluginReceives('svc')).toBeNull();
    expect(received.filter((value) => value.includes(FAKE))).toEqual([`Key ${FAKE}`]);
  });

  it.each([
    'X-Request-Id', 'x-request-id', 'ETag', 'Content-Disposition', 'OC-FileId', 'X-RateLimit-Key', 'X-Custom-Token',
    'Authorization ', 'X-Authorization', 'X-API-Key', '', 'constructor',
  ])('no header is built for the name %j', (name) => {
    expect(authHeaderFor({ type: 'header', name }, FAKE, undefined)).toBeNull();
    expect(authHeaderFor({ type: 'header', name, prefix: 'Bearer ' }, FAKE, 'alice')).toBeNull();
  });

  it('bearer and basic are built as before', () => {
    expect(authHeaderFor({ type: 'bearer' }, FAKE, undefined)).toEqual(['authorization', `Bearer ${FAKE}`]);
    expect(authHeaderFor({ type: 'basic' }, FAKE, 'alice')).toEqual(['authorization', `Basic ${Buffer.from(`alice:${FAKE}`).toString('base64')}`]);
    expect(authHeaderFor({ type: 'none' }, FAKE, undefined)).toBeNull();
  });
});

describe('how a header name is matched', () => {
  const header = (name: unknown) => checkInject({ type: 'header', name });

  it('takes a listed name in any case, and gives it back as written', () => {
    for (const name of CREDENTIAL_HEADER_NAMES) {
      for (const spelled of [name, name.toLowerCase(), name.toUpperCase()]) {
        expect(header(spelled)).toEqual({ type: 'header', name: spelled });
        expect(authHeaderFor({ type: 'header', name: spelled }, 's', undefined)).toEqual([name.toLowerCase(), 's']);
      }
    }
  });

  it.each([
    ['a leading space', ' Authorization'],
    ['a trailing space', 'Authorization '],
    ['a trailing tab', 'Authorization\t'],
    ['a trailing colon', 'Authorization:'],
    ['a colon and a second header', 'Authorization: x\r\nX-Request-Id'],
    ['a line break', 'Authorization\r\nX-Request-Id: 1'],
    ['a line feed alone', 'X-API-Key\nX-Request-Id'],
    ['a NUL', 'Authorization\u0000'],
    ['a suffix', 'Authorization-Extra'],
    ['a suffix on an API-key name', 'X-API-Key-Id'],
    ['a prefix', 'X-Authorization'],
    ['a Cyrillic a', 'Аuthorization'],
    ['a Cyrillic o', 'Authоrization'],
    ['a Turkish dotless i', 'Authorızation'],
    ['a Turkish dotted I, which lower-cases to i and a combining dot', 'AUTHORİZATION'],
    ['a long s', 'ſecretkey'],
    ['a full-width letter', 'Ａuthorization'],
    ['a soft hyphen', 'Author­ization'],
    ['a zero-width space', 'X-API-Key​'],
    ['a no-break space', 'X-API-Key '],
    ['an underscore for the hyphen', 'X_API_Key'],
    ['no hyphen', 'XAPIKey'],
    ['a Kelvin sign for the K, which lower-cases to k', 'X-API-Key'],
    ['the empty name', ''],
    ['a name from the prototype', 'constructor'],
    ['__proto__', '__proto__'],
    ['toString', 'toString'],
  ])('refuses a listed name with %s', (_what, name) => {
    expect(header(name)).toBeNull();
    expect(isCredentialHeader(name)).toBe(false);
    expect(unlistedCredentialHeaders({ svc: { inject: { type: 'header', name } } })).toEqual([name]);
  });

  it.each([
    ['a number', 1], ['a list', ['Authorization']], ['an object', { toLowerCase: () => 'authorization' }], ['null', null], ['nothing', undefined], ['true', true],
  ])('refuses %s for a name', (_what, name) => {
    expect(header(name)).toBeNull();
  });

  it('a kept version with a header that is no text at all is found, and one with a listed header is not', () => {
    expect(unlistedCredentialHeaders({ a: { inject: { type: 'header', name: ['Authorization'] } } })).toHaveLength(1);
    expect(unlistedCredentialHeaders({ a: { inject: { type: 'header' } } })).toHaveLength(1);
    expect(unlistedCredentialHeaders({ a: { inject: { type: 'header', name: 'authorization', prefix: 'Token ' } }, b: { inject: { type: 'bearer' } }, c: null })).toEqual([]);
  });

  it('the prefix cannot carry a second header', () => {
    expect(checkInject({ type: 'header', name: 'Authorization', prefix: 'Token ' })).toEqual({ type: 'header', name: 'Authorization', prefix: 'Token ' });
    expect(checkInject({ type: 'header', name: 'Authorization', prefix: 'x\r\nX-Request-Id: ' })).toBeNull();
    expect(checkInject({ type: 'header', name: 'Authorization', prefix: 'x\nX-Request-Id: ' })).toBeNull();
    expect(checkInject({ type: 'header', name: 'Authorization', prefix: 'x'.repeat(33) })).toBeNull();
  });

  it('what an author sees for a header outside the list', () => {
    const { errors } = checkCredentials(
      { gitlab: { label: 'GitLab', scope: 'admin', inject: { type: 'header', name: 'PRIVATE-TOKEN' }, secretKey: 'token', origin: 'https://gitlab.example' } },
      { token: { type: 'secret' } },
    );
    expect(errors).toEqual([
      'credentials.gitlab.inject is invalid: "PRIVATE-TOKEN" is not a header a credential may use (Authorization, X-API-Key, X-Goog-Api-Key, DHL-API-Key, 17token, secretkey)',
    ]);
  });
});
