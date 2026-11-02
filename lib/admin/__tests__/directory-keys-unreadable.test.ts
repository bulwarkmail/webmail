// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@/lib/extension-package';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from './shared-store-fake';
import { checkBundleSignature, clearKeyringCache } from '../directory-keys';
import { directoryKeyringDocs } from '../extension-store';

// The newest keyring date seen per directory stops a replayed old keyring.
// When that record can't be read, the install has to be refused: before,
// a broken or unreadable file counted as "nothing seen yet", so the replay
// went through exactly then.

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

function ring() {
  const issuedAt = '2026-10-20T00:00:00.000Z';
  const body = {
    _type: 'https://extensions.bulwarkmail.org/keyring/v1',
    rootKeyId: root.keyId,
    issuedAt,
    keys: [{ keyId: online.keyId, publicKey: online.raw, status: 'active', notBefore: issuedAt, notAfter: null }],
  };
  return { ...body, signature: sig(root.privateKey, canonicalJson(body)) };
}

function check() {
  const statement = canonicalJson({
    _type: 'https://extensions.bulwarkmail.org/release/v1', slug: 'jitsi-meet', version: '1.2.0', kind: 'plugin',
    bundle: { sha256, size: bytes.byteLength }, source: { host: 'github.com', repo: 'o/r', commit: 'c'.repeat(40), subpath: '' },
    approvedAt: '2026-10-14T00:00:00.000Z',
  });
  return checkBundleSignature({
    directoryUrl: DIR, configuredRootKeys: root.raw, slug: 'jitsi-meet', version: '1.2.0', kind: 'plugin', bytes,
    headers: new Headers({
      'x-bundle-statement': Buffer.from(statement, 'utf8').toString('base64'),
      'x-bundle-signature': sig(online.privateKey, statement),
      'x-bundle-signature-key': online.keyId,
    }),
    fetchImpl: (async () => Response.json(ring())) as typeof fetch,
  });
}

let dir: string;
const recordFile = () => path.join(dir, 'state', 'directory-keyrings.json');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-keyrings-unreadable-'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  await mkdir(path.join(dir, 'state'), { recursive: true });
  clearKeyringCache();
  resetLocalStoreForTests();
});

afterEach(async () => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('an unreadable keyring date record', () => {
  it('records the date when nothing was recorded yet', async () => {
    expect(await check()).toMatchObject({ status: 'verified' });
    expect(JSON.parse(await readFile(recordFile(), 'utf-8'))).toEqual({ [DIR]: '2026-10-20T00:00:00.000Z' });
  });

  it('refuses the bundle when the file is broken, and leaves the file alone', async () => {
    await writeFile(recordFile(), '{"https://directory.test": "2026-10-2', { mode: 0o600 });
    expect(await check()).toMatchObject({ status: 'invalid', reason: expect.stringContaining('could not be read') });
    expect(await readFile(recordFile(), 'utf-8')).toBe('{"https://directory.test": "2026-10-2');
  });

  it('refuses the bundle when the file cannot be read', async () => {
    await mkdir(recordFile());
    expect(await check()).toMatchObject({ status: 'invalid' });
  });

  it('refuses the bundle when the record in the shared store is broken', async () => {
    setStoreForTests(separateFakeStore(path.join(dir, 'store')));
    await directoryKeyringDocs().put('directory-keyrings.json', 'not json');
    expect(await check()).toMatchObject({ status: 'invalid', reason: expect.stringContaining('could not be read') });
    expect((await directoryKeyringDocs().get('directory-keyrings.json'))!.data.toString()).toBe('not json');
  });
});
