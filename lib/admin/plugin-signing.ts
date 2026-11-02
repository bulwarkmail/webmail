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
//
// With a shared store (#1066) and no PLUGIN_SIGNING_KEY_FILE, the key lives
// in the store instead (kv `plugin-signing-key`): the first replica that
// needs it creates it there if nobody has, then every replica reads it back,
// so all of them sign with the same key. Read-only config keeps using the
// mounted key file, as in local mode.
//
// Whatever the source, in shared mode each replica compares its key's
// fingerprint with the one stored by the first replica that loaded a key
// (kv `plugin-signing-key-fingerprint`). A replica with another key (a
// PLUGIN_SIGNING_KEY_FILE or read-only config set on some replicas only)
// refuses to sign and to hand out its public key: its signatures would
// fail on clients that got the key from another replica.

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, KeyObject } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { ensureConfigDir, getConfigPath, assertWritable, isConfigReadOnly } from './paths';
import { getStore, isSharedMode, StoreUnavailableError } from '@/lib/shared-store';
import { logger } from '@/lib/logger';

const KEY_FILENAME = 'plugin-signing.key';

type KeyPair = { privateKey: KeyObject; publicKey: KeyObject };

/**
 * This replica's key isn't the deployment's. A StoreUnavailableError by
 * name, so installs that need a signature answer 503 and write nothing.
 */
export class SigningKeyMismatchError extends StoreUnavailableError {
  readonly code = 'plugin-signing-key-mismatch';
}

export function isSigningKeyMismatch(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'plugin-signing-key-mismatch';
}

/** The fingerprint every replica's key is compared with (shared mode). */
export const SHARED_FINGERPRINT_NAME = 'plugin-signing-key-fingerprint';

/**
 * The loaded key, on globalThis: Next evaluates this module once per bundle
 * entry (three times in the build), and every copy must sign with the same
 * key and share one load.
 */
interface SigningGlobals {
  cached: KeyPair | null;
  init: Promise<void> | null;
  /** Bumped by invalidatePluginSigningCache, so a load that started before doesn't win. */
  generation: number;
}
const GLOBAL_KEY = Symbol.for('bulwark.admin.pluginSigning');

function signingGlobals(): SigningGlobals {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: SigningGlobals };
  return (g[GLOBAL_KEY] ??= { cached: null, init: null, generation: 0 });
}

function parseKey(pem: string, source: string): KeyPair {
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

async function loadOrCreate(): Promise<{ pair: KeyPair; source: string }> {
  // An empty value (`PLUGIN_SIGNING_KEY_FILE=` in an env file) means unset,
  // like the other *_FILE variables. Reading '' fails, and a failed load
  // makes every bundle ship unsigned with only a console warning.
  const externalPath = process.env.PLUGIN_SIGNING_KEY_FILE?.trim();
  if (externalPath) return { pair: await loadExternal(externalPath), source: 'PLUGIN_SIGNING_KEY_FILE' };

  if (isSharedMode() && !isConfigReadOnly()) return { pair: await loadOrCreateShared(), source: 'the shared store' };
  return { pair: await loadOrCreateFile(), source: `${KEY_FILENAME} in the admin config dir` };
}

function fingerprintOf(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(spki.subarray(spki.length - 32)).digest('hex').slice(0, 32);
}

/** Shared mode: refuse a key that isn't the one the first replica recorded. */
async function assertDeploymentKey(pair: KeyPair, source: string): Promise<void> {
  if (!isSharedMode()) return;
  const kv = getStore().kv;
  const mine = fingerprintOf(pair.publicKey);
  await kv.set(SHARED_FINGERPRINT_NAME, mine, { ifAbsent: true });
  const recorded = await kv.get(SHARED_FINGERPRINT_NAME);
  if (recorded !== null && recorded !== mine) {
    throw new SigningKeyMismatchError(
      `This instance's plugin signing key (from ${source}) is not the one the other instances use. ` +
      'Give every instance the same PLUGIN_SIGNING_KEY_FILE (or none). After rotating the key on every instance on purpose, ' +
      `delete the shared store's ${SHARED_FINGERPRINT_NAME} key.`,
    );
  }
}

/** The key the store's kv holds. Exported for the shared-store import. */
export const SHARED_KEY_NAME = 'plugin-signing-key';

/**
 * Shared mode: the one key every replica uses. Created only if absent, then
 * read back, so replicas starting at once agree on whichever was stored
 * first. A store outage fails the load (and with it the install that needs
 * a signature); it is tried again on the next use.
 */
async function loadOrCreateShared(): Promise<KeyPair> {
  const kv = getStore().kv;
  let pem = await kv.get(SHARED_KEY_NAME);
  if (pem === null) {
    const generated = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    if (await kv.set(SHARED_KEY_NAME, generated, { ifAbsent: true })) {
      logger.info('[plugin-signing] generated new Ed25519 keypair in the shared store');
    }
    pem = await kv.get(SHARED_KEY_NAME);
    if (pem === null) throw new Error('The plugin signing key could not be stored in the shared store');
  }
  return parseKey(pem, 'The shared store\'s plugin signing key');
}

async function readKeyFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The key file in the admin config dir, made on first use. Created with
 * `wx`: when two writers start at once (two processes, or module copies
 * that missed each other's load), only one key is ever written and the
 * other writer reads it back, so every signature verifies against the same
 * key. Before, the last write won and signatures made with the first key
 * stopped verifying.
 */
async function loadOrCreateFile(): Promise<KeyPair> {
  await ensureConfigDir();
  const path = getConfigPath(KEY_FILENAME);

  const existing = await readKeyFile(path);
  if (existing !== null) return parseExistingKey(path, existing);

  assertWritable('plugin-signing.generateKeypair');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  try {
    await writeFile(path, pem, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Someone else made the key first: use theirs.
    return parseExistingKey(path, (await readKeyFile(path)) ?? '');
  }
  // Ensure 0600 on filesystems that ignored mode on writeFile.
  try { await chmod(path, 0o600); } catch { /* best effort */ }
  logger.info('[plugin-signing] generated new Ed25519 keypair');
  return { privateKey, publicKey };
}

/**
 * Parse a key file another writer may still be writing: an empty or cut
 * off file is read again for up to a second before it counts as broken.
 */
async function parseExistingKey(path: string, pem: string): Promise<KeyPair> {
  for (let attempt = 0; ; attempt++) {
    try {
      return parseKey(pem, KEY_FILENAME);
    } catch (err) {
      if (attempt >= 20 || pem.includes('-----END PRIVATE KEY-----')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
      pem = (await readKeyFile(path)) ?? '';
    }
  }
}

async function ensureLoaded(): Promise<KeyPair> {
  const g = signingGlobals();
  if (g.cached) return g.cached;
  if (!g.init) {
    const generation = g.generation;
    g.init = (async () => {
      try {
        const { pair: loaded, source } = await loadOrCreate();
        await assertDeploymentKey(loaded, source);
        // A rotation (invalidatePluginSigningCache) during the load wins.
        if (g.generation === generation) g.cached = loaded;
      } catch (err) {
        if (g.generation === generation) g.init = null;
        logger.error('[plugin-signing] keypair load failed', { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    })();
  }
  await g.init;
  return g.cached ?? ensureLoaded();
}

// ─── Public API ──────────────────────────────────────────────

/** Returns the public key as a raw 32-byte Uint8Array (Ed25519 standard form). */
export async function getPublicKeyRaw(): Promise<Uint8Array> {
  const { publicKey } = await ensureLoaded();
  // Export as SPKI DER and pull the last 32 bytes (the raw key after the
  // 12-byte AlgorithmIdentifier prefix). Node has no built-in raw export
  // for Ed25519, but the SPKI prefix is fixed for Ed25519 so the slice is
  // safe.
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
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
  const { privateKey } = await ensureLoaded();
  const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes);
  const sig = nodeSign(null, data, privateKey);
  return sig.toString('base64');
}

/** Whether `signature` (base64) is this key's signature of `bytes`. */
export async function verifyBytes(bytes: Uint8Array | string, signature: string): Promise<boolean> {
  const { publicKey } = await ensureLoaded();
  const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes);
  try {
    return nodeVerify(null, data, publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Force a re-read on next access. Used after operator rotates the key. */
export function invalidatePluginSigningCache(): void {
  const g = signingGlobals();
  g.cached = null;
  g.init = null;
  g.generation++;
}
