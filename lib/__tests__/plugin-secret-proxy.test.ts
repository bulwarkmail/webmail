// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('@/lib/admin/plugin-registry', () => ({ getPlugin: vi.fn(async () => null) }));
vi.mock('@/lib/admin/plugin-config', () => ({ getPluginConfig: vi.fn(async () => ({})) }));
// A user credential exists only for a plugin the server knows declares it
// (lib/plugin-secrets/known-plugins.ts): the Nextcloud plugin of these tests
// is an admin-approved upload.
vi.mock('@/lib/admin/plugin-approvals', () => ({
  listApprovals: async () => [{
    pluginId: 'nextcloud', status: 'approved',
    manifest: { credentials: { cloud: { scope: 'user', label: 'Nextcloud', inject: { type: 'basic' } } } },
  }],
}));
const auditLines: Record<string, unknown>[] = [];
vi.mock('@/lib/logger', () => ({
  logger: {
    info: (_msg: string, extra: Record<string, unknown>) => { auditLines.push(extra); },
    warn: () => {}, error: () => {}, debug: () => {},
  },
}));

import { getPlugin } from '@/lib/admin/plugin-registry';
import { getPluginConfig } from '@/lib/admin/plugin-config';
import { checkCredentials, authHeaderFor } from '../plugin-secrets/credentials';
import {
  deleteUserCredentials, getUserCredential, listUserCredentials, putUserCredential,
} from '../plugin-secrets/vault';
import { adminCredentialStatus, proxyRequest, ProxyError, PROXY_RATE_LIMIT, resetProxyLimits } from '../plugin-secrets/proxy';

const USER = { username: 'alice@example.org', serverUrl: 'https://mail.example.org' };
const OTHER = { username: 'bob@example.org', serverUrl: 'https://mail.example.org' };

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let seen: Seen[] = [];
let server: http.Server;
let origin: string;
let vaultDir: string;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-for-the-plugin-vault-0123456789';
  vaultDir = mkdtempSync(path.join(tmpdir(), 'plugin-vault-'));
  process.env.PLUGIN_SECRETS_DIR = vaultDir;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/redirect-away') {
        res.writeHead(302, { location: 'https://elsewhere.example/steal' });
        return res.end();
      }
      if (req.url === '/.well-known/caldav') {
        res.writeHead(307, { location: '/remote.php/dav/' });
        return res.end();
      }
      if (req.url === '/login/poll') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ server: origin, loginName: 'alice', appPassword: 'app-pw-123' }));
      }
      res.writeHead(207, { 'content-type': 'application/xml', 'set-cookie': 'sid=upstream', dav: '1, 3', 'x-powered-by': 'php' });
      res.end('<d:multistatus/>');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PLUGIN_PROXY_PRIVATE_ORIGINS = origin;
});

afterAll(() => {
  server.close();
  rmSync(vaultDir, { recursive: true, force: true });
});

beforeEach(async () => {
  seen = [];
  auditLines.length = 0;
  resetProxyLimits();
  await deleteUserCredentials(USER, 'nextcloud');
  await deleteUserCredentials(OTHER, 'nextcloud');
});

async function connect(secret?: string) {
  await putUserCredential(USER, 'nextcloud', 'cloud', {
    origin, inject: { type: 'basic' }, label: 'Nextcloud', username: 'alice', ...(secret ? { secret } : {}),
  });
}

function call(over: Partial<Parameters<typeof proxyRequest>[0]> = {}) {
  return proxyRequest({
    user: USER, pluginId: 'nextcloud', credentialId: 'cloud',
    url: `${origin}/remote.php/dav/files/alice/`, method: 'PROPFIND',
    headers: new Headers({ depth: '1', cookie: 'webmail-session=secret', 'content-type': 'application/xml' }),
    body: null,
    ...over,
  });
}

describe('credential specs in the manifest', () => {
  it('accepts a user credential and an admin one that points at a secret field', () => {
    const { credentials, errors } = checkCredentials({
      cloud: { label: 'Nextcloud', scope: 'user', inject: { type: 'basic' } },
      ai: { label: 'OpenAI', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', origin: 'https://api.openai.com' },
    }, { key: { type: 'secret' } });

    expect(errors).toEqual([]);
    expect(credentials?.ai).toMatchObject({ scope: 'admin', secretKey: 'key', origin: 'https://api.openai.com' });
  });

  it('refuses an admin credential whose secret is a plain field, and headers the proxy owns', () => {
    expect(checkCredentials({ ai: { label: 'AI', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', origin: 'https://a.example' } },
      { key: { type: 'string' } }).errors.join()).toMatch(/"secret" field/);
    expect(checkCredentials({ x: { label: 'X', scope: 'user', inject: { type: 'header', name: 'Cookie' } } }, undefined).errors.join())
      .toMatch(/inject is invalid/);
  });

  it('takes appPassword only on a user credential with basic auth', () => {
    const user = { label: 'Stalwart', scope: 'user', inject: { type: 'basic' } };
    expect(checkCredentials({ stalwart: { ...user, appPassword: true } }, undefined))
      .toEqual({ credentials: { stalwart: { ...user, appPassword: true } }, errors: [] });
    expect(checkCredentials({ stalwart: { ...user, inject: { type: 'bearer' }, appPassword: true } }, undefined).errors.join())
      .toMatch(/needs inject "basic"/);
    expect(checkCredentials({ stalwart: { ...user, appPassword: 'yes' } }, undefined).errors.join()).toMatch(/must be true/);
    expect(checkCredentials({ ai: { label: 'AI', scope: 'admin', inject: { type: 'basic' }, secretKey: 'key', origin: 'https://a.example', appPassword: true } },
      { key: { type: 'secret' } }).errors.join()).toMatch(/only for scope "user"/);
  });

  it('builds the auth header', () => {
    expect(authHeaderFor({ type: 'basic' }, 'pw', 'alice')).toEqual(['authorization', `Basic ${Buffer.from('alice:pw').toString('base64')}`]);
    expect(authHeaderFor({ type: 'header', name: 'x-api-key' }, 'k', undefined)).toEqual(['x-api-key', 'k']);
    expect(authHeaderFor({ type: 'bearer' }, undefined, undefined)).toBeNull();
  });
});

describe('vault', () => {
  it('keeps secrets encrypted and out of the list', async () => {
    await connect('app-pw');

    expect((await getUserCredential(USER, 'nextcloud', 'cloud'))?.secret).toBe('app-pw');
    const list = await listUserCredentials(USER);
    expect(list).toEqual([expect.objectContaining({ pluginId: 'nextcloud', credentialId: 'cloud', origin, connected: true })]);
    expect(JSON.stringify(list)).not.toContain('app-pw');
    const files = readdirSync(vaultDir).map((f) => readFileSync(path.join(vaultDir, f), 'utf8'));
    expect(files.join()).not.toContain('app-pw');
  });

  it('is per account', async () => {
    await connect('app-pw');

    expect(await getUserCredential(OTHER, 'nextcloud', 'cloud')).toBeNull();
  });

  it('says what it removed, with the app password the server made', async () => {
    await putUserCredential(USER, 'nextcloud', 'cloud', {
      origin, inject: { type: 'basic' }, label: 'Nextcloud', username: 'alice', secret: 'made', appPasswordId: 'ap1',
    });

    expect(await deleteUserCredentials(USER, 'nextcloud', 'other')).toEqual([]);
    expect(await deleteUserCredentials(USER, 'nextcloud')).toEqual([expect.objectContaining({ appPasswordId: 'ap1', secret: 'made' })]);
    expect(await getUserCredential(USER, 'nextcloud', 'cloud')).toBeNull();
  });

  it('drops the secret when the server address changes', async () => {
    await connect('app-pw');
    await putUserCredential(USER, 'nextcloud', 'cloud', { origin: 'https://evil.example', inject: { type: 'basic' }, label: 'Nextcloud' });

    expect((await getUserCredential(USER, 'nextcloud', 'cloud'))?.secret).toBeUndefined();
  });
});

describe('proxy', () => {
  it('adds the secret, drops the browser cookie and filters what comes back', async () => {
    await connect('app-pw');

    const res = await call();

    expect(res.status).toBe(207);
    expect(await res.text()).toBe('<d:multistatus/>');
    expect(seen[0].method).toBe('PROPFIND');
    expect(seen[0].headers.authorization).toBe(`Basic ${Buffer.from('alice:app-pw').toString('base64')}`);
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers.depth).toBe('1');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('dav')).toBe('1, 3');
  });

  it('sends a request body with its length, not chunked', async () => {
    await connect('app-pw');
    const body = new Blob(['file contents']).stream();

    const res = await call({ method: 'PUT', url: `${origin}/remote.php/dav/files/alice/a.txt`, body });
    await res.text();

    expect(seen[0].body).toBe('file contents');
    // Django-based servers read a chunked multipart body as empty.
    expect(seen[0].headers['content-length']).toBe('13');
    expect(seen[0].headers['transfer-encoding']).toBeUndefined();
  });

  it('only sends a credential to its own server', async () => {
    await connect('app-pw');

    await expect(call({ url: 'https://elsewhere.example/x' })).rejects.toMatchObject({ code: 'wrong_origin', status: 403 });
    expect(seen).toEqual([]);
  });

  it('refuses to follow a redirect to another server', async () => {
    await connect('app-pw');

    await expect(call({ method: 'GET', url: `${origin}/redirect-away` })).rejects.toMatchObject({ code: 'redirect_off_origin' });
    expect(seen).toHaveLength(1);
  });

  it('follows a redirect on the same server with the body and says where it ended up', async () => {
    await connect('app-pw');

    const res = await call({ url: `${origin}/.well-known/caldav`, body: new Blob(['<propfind/>']).stream() });
    await res.text();

    expect(seen.map((r) => [r.method, r.url, r.body])).toEqual([
      ['PROPFIND', '/.well-known/caldav', '<propfind/>'],
      ['PROPFIND', '/remote.php/dav/', '<propfind/>'],
    ]);
    expect(res.headers.get('x-bulwark-url')).toBe(`${origin}/remote.php/dav/`);
  });

  it('refuses a WebDAV move to another server', async () => {
    await connect('app-pw');

    await expect(call({ method: 'MOVE', headers: new Headers({ destination: 'https://elsewhere.example/x' }) }))
      .rejects.toMatchObject({ code: 'bad_destination' });
    expect(seen).toEqual([]);
  });

  it('does not use a credential the user never connected', async () => {
    await expect(call()).rejects.toBeInstanceOf(ProxyError);
    await expect(call()).rejects.toMatchObject({ code: 'no_credential' });
  });

  it('stores a secret from a sign-in response and hides it from the plugin', async () => {
    await connect();

    const res = await call({ method: 'POST', url: `${origin}/login/poll`, capture: { secret: 'appPassword', username: 'loginName' } });
    const body = await res.json();

    expect(body).toEqual({ server: origin, captured: true });
    const stored = await getUserCredential(USER, 'nextcloud', 'cloud');
    expect(stored).toMatchObject({ secret: 'app-pw-123', username: 'alice' });
  });

  it('keeps an app password the server made from being replaced by a captured one', async () => {
    await putUserCredential(USER, 'nextcloud', 'cloud', {
      origin, inject: { type: 'basic' }, label: 'Nextcloud', username: 'alice', secret: 'made', appPasswordId: 'ap1',
    });

    const res = await call({ method: 'POST', url: `${origin}/login/poll`, capture: { secret: 'appPassword', username: 'loginName' } });

    expect(await res.json()).toEqual({ server: origin, captured: false });
    expect(await getUserCredential(USER, 'nextcloud', 'cloud')).toMatchObject({ secret: 'made', appPasswordId: 'ap1' });
  });

  it('limits requests per minute', async () => {
    await connect('app-pw');
    // In batches below the concurrency cap, so only the per-minute limit applies.
    for (let i = 0; i < PROXY_RATE_LIMIT; i += 6) {
      const n = Math.min(6, PROXY_RATE_LIMIT - i);
      await Promise.all(Array.from({ length: n }, async () => (await call()).text()));
    }

    await expect(call()).rejects.toMatchObject({ status: 429 });
  }, 60_000);

  it('writes an audit line without paths, headers or bodies', async () => {
    await connect('app-pw');
    await (await call()).text();
    await new Promise((r) => setTimeout(r, 10));

    expect(auditLines).toEqual([expect.objectContaining({ plugin: 'nextcloud', credential: 'cloud', method: 'PROPFIND', status: 207 })]);
    expect(JSON.stringify(auditLines)).not.toMatch(/remote\.php|app-pw|alice@/);
  });

  it('uses an admin credential without a secret for a keyless service', async () => {
    vi.mocked(getPlugin).mockResolvedValueOnce({
      id: 'ai', enabled: true,
      credentials: { local: { label: 'Ollama', scope: 'admin', inject: { type: 'none' }, secretKey: 'key', originKey: 'url' } },
    } as never);
    vi.mocked(getPluginConfig).mockResolvedValueOnce({ url: `${origin}/v1` });

    const res = await call({ pluginId: 'ai', credentialId: 'local', method: 'POST', url: `${origin}/v1/chat` });
    await res.text();

    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('says which admin credentials are set up, without their secrets', async () => {
    const plugin = {
      id: 'ai', enabled: true,
      credentials: {
        llm: { label: 'LLM', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', originKey: 'url' },
        other: { label: 'Other', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'otherKey', origin: 'https://o.example' },
        own: { label: 'Own', scope: 'user', inject: { type: 'bearer' } },
      },
    };
    vi.mocked(getPlugin).mockResolvedValue(plugin as never);
    vi.mocked(getPluginConfig).mockResolvedValue({ key: 'sk-admin', url: `${origin}/v1` });
    try {
      const status = await adminCredentialStatus('ai');

      expect(status).toEqual([{ credentialId: 'llm', configured: true }, { credentialId: 'other', configured: false }]);
      expect(JSON.stringify(status)).not.toContain('sk-admin');
    } finally {
      vi.mocked(getPlugin).mockResolvedValue(null);
      vi.mocked(getPluginConfig).mockResolvedValue({});
    }
  });

  it('uses an admin credential for an installed plugin', async () => {
    vi.mocked(getPlugin).mockResolvedValueOnce({
      id: 'ai', enabled: true,
      credentials: { llm: { label: 'LLM', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', originKey: 'url' } },
    } as never);
    vi.mocked(getPluginConfig).mockResolvedValueOnce({ key: 'sk-admin', url: `${origin}/v1` });

    const res = await call({ pluginId: 'ai', credentialId: 'llm', method: 'POST', url: `${origin}/v1/chat` });
    await res.text();

    expect(seen[0].headers.authorization).toBe('Bearer sk-admin');
  });
});
