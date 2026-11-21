/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every connection the store module opens, by address. Nothing is dialled.
const connections = vi.hoisted(() => [] as string[]);
vi.mock('ioredis', () => {
  class FakeRedis {
    status = 'connecting';
    constructor(url: string) {
      connections.push(url);
    }
    defineCommand() {}
    on() {
      return this;
    }
    once() {
      return this;
    }
    disconnect() {}
  }
  return { default: FakeRedis };
});

import { bootState, getStore, setBootState, setStoreForTests, storeUrlRefusal } from '../index';
import { bootGateResponse } from '../boot-gate';

// ioredis' own URL reader, the one the store's client runs on the address (not mocked).
const { parseURL } = createRequire(import.meta.url)('ioredis/built/utils/index.js') as {
  parseURL: (url: string) => { password?: string | null };
};

const ENV = ['REDIS_URL', 'REDIS_URL_FILE', 'SHARED_STORE_ALLOW_NO_PASSWORD'] as const;
let saved: Record<string, string | undefined>;
let dir: string | undefined;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  connections.length = 0;
  setStoreForTests(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setStoreForTests(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

describe('a shared store address without a password', () => {
  it.each([
    ['no password at all', 'redis://valkey:6379/0'],
    ['an empty password (a blank VALKEY_PASSWORD in the manifests)', 'redis://:@valkey:6379/0'],
    ['a user name without a password', 'redis://bulwark@valkey:6379/0'],
    ['host and port only', 'valkey:6379'],
    ['a socket path', '/run/valkey/valkey.sock'],
  ])('is refused before anything connects: %s', (_name, url) => {
    process.env.REDIS_URL = url;
    expect(() => getStore()).toThrow(/has no password[^]*SHARED_STORE_ALLOW_NO_PASSWORD=true/);
    expect(connections).toEqual([]);
  });

  it('is refused when it comes from REDIS_URL_FILE too', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'store-url-'));
    const file = path.join(dir, 'redis-url');
    writeFileSync(file, 'redis://valkey:6379/0\n');
    process.env.REDIS_URL_FILE = file;
    expect(() => getStore()).toThrow(/has no password/);
    expect(connections).toEqual([]);
  });

  it('stays refused on every call, and the log says why once', () => {
    process.env.REDIS_URL = 'redis://valkey:6379/0';
    expect(() => getStore()).toThrow(/has no password/);
    expect(() => getStore()).toThrow(/has no password/);
    expect(connections).toEqual([]);
    const logged = vi.mocked(console.error).mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('has no password'));
    expect(logged).toHaveLength(1);
  });

  it('is used with SHARED_STORE_ALLOW_NO_PASSWORD=true, as before', () => {
    process.env.REDIS_URL = 'redis://valkey:6379/0';
    process.env.SHARED_STORE_ALLOW_NO_PASSWORD = 'true';
    expect(getStore().mode).toBe('redis');
    expect(connections).toEqual(['redis://valkey:6379/0']);
  });

  it('is still refused when the switch says anything but true', () => {
    process.env.REDIS_URL = 'redis://valkey:6379/0';
    process.env.SHARED_STORE_ALLOW_NO_PASSWORD = 'false';
    expect(() => getStore()).toThrow(/has no password/);
    expect(connections).toEqual([]);
  });
});

describe('a shared store address with a password', () => {
  it.each([
    ['in the address', 'redis://:a-made-up-password@valkey:6379/0'],
    ['with a user name', 'rediss://bulwark:a-made-up-password@valkey:6380/0'],
    ['percent-encoded', 'redis://:made%2Fup%40pass@valkey:6379/0'],
    ['in the query', 'redis://valkey:6379/0?password=a-made-up-password'],
  ])('is used as before: %s', (_name, url) => {
    process.env.REDIS_URL = url;
    expect(getStore().mode).toBe('redis');
    expect(connections).toEqual([url]);
  });
});

describe('the password is the one ioredis will send', () => {
  it.each([
    'redis://valkey:6379/0',
    'redis://:a-made-up-password@valkey:6379/0',
    'redis://default:a-made-up-password@valkey:6379/0',
    'redis://valkey:6379/0?password=a-made-up-password',
    // A user in the address: ioredis takes the address' (empty) password and ignores the query.
    'redis://default@valkey:6379/0?password=a-made-up-password',
    // Neither user nor password in the address: the query counts.
    'redis://:@valkey:6379/0?password=a-made-up-password',
    // The last ?password= wins.
    'redis://valkey:6379/0?password=a-made-up-password&password=',
    'redis://valkey:6379/0?password=&password=a-made-up-password',
    'valkey:6379?password=a-made-up-password',
    '//valkey:6379?password=a-made-up-password',
    '/run/valkey/valkey.sock?password=a-made-up-password',
    '/run/valkey/valkey.sock',
    '6379',
    'rediss://:made%2Fup%40pass@valkey:6380/0',
  ])('%s', (url) => {
    const sends = parseURL(url).password ?? '';
    expect({ url, refused: storeUrlRefusal(url) !== null }).toEqual({ url, refused: sends === '' });
  });
});

describe('a shared store address that is not a URL', () => {
  it('is refused with what to fix, also with the switch on', () => {
    // A base64 password with a "/" in it, not percent-encoded.
    process.env.REDIS_URL = 'redis://:made/up+pass=@valkey:6379/0';
    process.env.SHARED_STORE_ALLOW_NO_PASSWORD = 'true';
    expect(() => getStore()).toThrow(/not a valid URL[^]*percent-encoded/);
    expect(connections).toEqual([]);
  });
});

describe('without a shared store address', () => {
  it('runs on local files, as before', () => {
    expect(getStore().mode).toBe('local');
    expect(connections).toEqual([]);
  });
});

describe('what a replica with a refused store answers', () => {
  async function answer(pathname: string) {
    const res = bootGateResponse(pathname);
    expect(res?.status).toBe(503);
    return { type: res!.headers.get('content-type'), text: await res!.text() };
  }

  it('is in the refused state, before boot and after boot set "starting", and never throws', () => {
    process.env.REDIS_URL = 'redis://valkey.internal:6379/0';
    expect(bootState()).toBe('refused');
    setBootState('starting'); // as instrumentation leaves it once getStore() refused
    expect(bootState()).toBe('refused');
    expect(connections).toEqual([]);
  });

  it('says why and what to set, on pages and on the API, without the address', async () => {
    process.env.REDIS_URL = 'redis://valkey.internal:6379/0';
    const page = await answer('/en/mail');
    expect(page.type).toMatch(/^text\/plain/);
    expect(page.text).toMatch(/no password/);
    expect(page.text).toMatch(/REDIS_URL/);
    expect(page.text).toMatch(/SHARED_STORE_ALLOW_NO_PASSWORD=true/);
    expect(page.text).not.toMatch(/is starting|valkey\.internal|6379/);
    const api = JSON.parse((await answer('/api/config')).text);
    expect(api).toEqual({ error: 'not_ready', state: 'refused', message: page.text });
  });

  it('names the URL problem for an address that is not a URL', async () => {
    process.env.REDIS_URL = 'redis://:made/up+pass=@valkey.internal:6379/0';
    expect(bootState()).toBe('refused');
    const page = await answer('/');
    expect(page.text).toMatch(/not a valid URL/);
    expect(page.text).not.toMatch(/made\/up|valkey\.internal/);
  });

  it('leaves an accepted store as it was: starting, then serving', async () => {
    process.env.REDIS_URL = 'redis://:a-made-up-password@valkey.internal:6379/0';
    expect(bootState()).toBe('starting');
    expect((await answer('/')).text).toBe('Bulwark is starting and connecting to its shared store.');
    setBootState('ready');
    expect(bootGateResponse('/')).toBeNull();
  });

  it('leaves local mode as it was: ready, no gate', () => {
    expect(bootState()).toBe('ready');
    expect(bootGateResponse('/')).toBeNull();
  });
});
