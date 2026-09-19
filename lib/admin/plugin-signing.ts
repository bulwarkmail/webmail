// Server-side Ed25519 signing for plugin bundles.
//
// Closes the "C2" audit finding: SHA-256 alone catches transport corruption
// but not a compromised server-side bundle store. With signing, even if an
// attacker swaps the bundle bytes in transit or at rest, the client refuses
// to load anything that doesn't verify against the host's public key.
//
// By default, the keypair lives at `data/admin/plugin-signing.key`
// (PEM-encoded PKCS#8 private, mode 0600) and is generated lazily on first
// use. Operators can instead point PLUGIN_SIGNING_KEY_FILE at a read-only
// secret outside the admin config directory.

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as nodeSign, KeyObject } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ensureConfigDir, getConfigPath, assertWritable } from './paths';
import { logger } from '@/lib/logger';

const KEY_FILENAME = 'plugin-signing.key';

let cached: { privateKey: KeyObject; publicKey: KeyObject } | null = null;
let initPromise: Promise<void> | null = null;

function parseKey(pem: string, source: string): { privateKey: KeyObject; publicKey: KeyObject } {
  let privateKey: KeyObject;
  try {
    if (!pem.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('not PKCS#8 PEM');
    privateKey = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
  } catch {
    throw new Error(`${source} is not a valid PEM PKCS#8 private key`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${source} has wrong key type (${privateKey.asymmetricKeyType}); expected ed25519`);
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

async function loadExternal(path: string): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  let pem: string;
  try {
    pem = await readFile(path, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read plugin signing key from PLUGIN_SIGNING_KEY_FILE: ${detail}`);
  }
  return parseKey(pem, 'PLUGIN_SIGNING_KEY_FILE');
}

async function loadOrCreate(): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  const externalPath = process.env.PLUGIN_SIGNING_KEY_FILE;
  if (externalPath !== undefined) return loadExternal(externalPath);

  await ensureConfigDir();
  const path = getConfigPath(KEY_FILENAME);

  if (existsSync(path)) {
    const pem = await readFile(path, 'utf-8');
    return parseKey(pem, KEY_FILENAME);
  }

  // First boot: generate and persist. Use sync APIs so a half-written file
  // never lingers if the process dies between writes.
  assertWritable('plugin-signing.generateKeypair');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  await writeFile(path, pem, { encoding: 'utf-8', mode: 0o600 });
  // Ensure 0600 on filesystems that ignored mode on writeFile.
  try { await chmod(path, 0o600); } catch { /* best effort */ }
  logger.info('[plugin-signing] generated new Ed25519 keypair');
  return { privateKey, publicKey };
}

async function ensureLoaded(): Promise<void> {
  if (cached) return;
  if (!initPromise) {
    initPromise = (async () => {
      try {
        cached = await loadOrCreate();
      } catch (err) {
        initPromise = null;
        logger.error('[plugin-signing] keypair load failed', { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    })();
  }
  await initPromise;
}

// ─── Public API ──────────────────────────────────────────────

/** Returns the public key as a raw 32-byte Uint8Array (Ed25519 standard form). */
export async function getPublicKeyRaw(): Promise<Uint8Array> {
  await ensureLoaded();
  // Export as SPKI DER and pull the last 32 bytes (the raw key after the
  // 12-byte AlgorithmIdentifier prefix). Node has no built-in raw export
  // for Ed25519, but the SPKI prefix is fixed for Ed25519 so the slice is
  // safe.
  const spki = cached!.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  if (spki.length < 32) throw new Error('SPKI export too short');
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Base64-encoded raw 32-byte public key (for embedding in HTTP responses). */
export async function getPublicKeyBase64(): Promise<string> {
  const raw = await getPublicKeyRaw();
  return Buffer.from(raw).toString('base64');
}

/** Sign `bytes` and return a base64-encoded 64-byte Ed25519 signature. */
export async function signBytes(bytes: Uint8Array | string): Promise<string> {
  await ensureLoaded();
  const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes);
  const sig = nodeSign(null, data, cached!.privateKey);
  return sig.toString('base64');
}

/** Force a re-read on next access. Used after operator rotates the key. */
export function invalidatePluginSigningCache(): void {
  cached = null;
  initPromise = null;
}
