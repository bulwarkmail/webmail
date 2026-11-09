// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@/lib/extension-package';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from './shared-store-fake';

// Several replicas share one store (#1066): the newest keyring date seen
// from a directory, which stops a replayed old keyring, must hold on every
// replica, not only on the one that saw it.

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { privateKey, raw: raw.toString('base64'), keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
}
const sig = (key: KeyObject, text: string) => sign(null, Buffer.from(text, 'utf8'), key).toString('base64');

const DIR = 'https://directory.test';
const root = keypair();
const online = keypair();
const bytes = new TextEncoder().encode('zip bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function ringAt(issuedAt: string) {
  const body = {
    _type: 'https://extensions.bulwarkmail.org/keyring/v1',
    rootKeyId: root.keyId,
    issuedAt,
    keys: [{ keyId: online.keyId, publicKey: online.raw, status: 'active', notBefore: issuedAt, notAfter: null }],
  };
  return { ...body, signature: sig(root.privateKey, canonicalJson(body)) };
}

function signedHeaders() {
  const statement = canonicalJson({
    _type: 'https://extensions.bulwarkmail.org/release/v1', slug: 'jitsi-meet', version: '1.2.0', kind: 'plugin',
    bundle: { sha256, size: bytes.byteLength }, source: { host: 'github.com', repo: 'o/r', commit: 'c'.repeat(40), subpath: '' },
    approvedAt: '2026-10-14T00:00:00.000Z',
  });
  return new Headers({
    'x-bundle-statement': Buffer.from(statement, 'utf8').toString('base64'),
    'x-bundle-signature': sig(online.privateKey, statement),
    'x-bundle-signature-key': online.keyId,
  });
}

/** A replica's copy of the module: its own keyring cache, nothing in memory. */
async function replica() {
  vi.resetModules();
  const mod = await import('../directory-keys');
  return (ring: unknown) => mod.checkBundleSignature({
    directoryUrl: DIR, configuredRootKeys: root.raw, slug: 'jitsi-meet', version: '1.2.0', kind: 'plugin',
    bytes, headers: signedHeaders(), fetchImpl: (async () => Response.json(ring)) as typeof fetch,
  });
}

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-keyrings-shared-'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  resetLocalStoreForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
});

afterEach(async () => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('directory keyring dates in the shared store', () => {
  it('refuses on another replica a keyring older than one this replica saw', async () => {
    const a = await replica();
    expect(await a(ringAt('2026-10-20T00:00:00.000Z'))).toMatchObject({ status: 'verified' });

    const b = await replica();
    expect(await b(ringAt('2026-10-14T00:00:00.000Z')))
      .toMatchObject({ status: 'invalid', reason: expect.stringContaining('older than the one seen before') });
    // Nothing was written to this replica's own state dir.
    expect(existsSync(path.join(dir, 'state', 'directory-keyrings.json'))).toBe(false);
  });

  it('fails with the store outage while the store is down, so the install answers 503', async () => {
    store.down = true;
    const a = await replica();
    await expect(a(ringAt('2026-10-20T00:00:00.000Z'))).rejects.toMatchObject({ name: 'StoreUnavailableError' });
  });
});
