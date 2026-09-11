/** Portable archive format. Only encrypted envelopes may cross the storage API. */
export interface VaultOwner { username: string; serverUrl: string }
export interface VaultAccount extends VaultOwner {
  password?: string;
  label: string;
  avatarColor: string;
}
export interface VaultContents {
  owner: VaultOwner;
  accounts: VaultAccount[];
  defaultAccountId: string | null;
}
export interface VaultEnvelope {
  version: 1;
  iterations: 600000;
  salt: string;
  iv: string;
  ciphertext: string;
}
export interface VaultRecord { revision: string; envelope: VaultEnvelope }
export const VAULT_MAX_BYTES = 256 * 1024;

export function normalizeVaultOwner(value: VaultOwner): VaultOwner {
  if (typeof value?.username !== 'string' || !value.username.trim() || value.username.length > 320
    || typeof value.serverUrl !== 'string' || value.serverUrl.length > 2048) throw new Error('invalid_archive');
  const url = new URL(value.serverUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid_archive');
  return { username: value.username.trim(), serverUrl: url.toString().replace(/\/+$/, '') };
}

export function vaultIdentity(owner: VaultOwner): string {
  const normalized = normalizeVaultOwner(owner);
  return JSON.stringify([normalized.username, normalized.serverUrl]);
}

/** Strict allowlist: never echo or persist arbitrary request fields. */
export function parseVaultEnvelope(value: unknown): VaultEnvelope {
  const v = value as VaultEnvelope | null;
  const base64 = (s: unknown, min: number, max: number): s is string =>
    typeof s === 'string' && s.length >= min && s.length <= max && s.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  if (!v || v.version !== 1 || v.iterations !== 600000
    || !base64(v.salt, 24, 24) || !base64(v.iv, 16, 16)
    || !base64(v.ciphertext, 24, VAULT_MAX_BYTES - 1024)) throw new Error('invalid_archive');
  try {
    if (atob(v.salt).length !== 16 || atob(v.iv).length !== 12 || atob(v.ciphertext).length < 16) throw new Error();
  } catch { throw new Error('invalid_archive'); }
  return { version: 1, iterations: 600000, salt: v.salt, iv: v.iv, ciphertext: v.ciphertext };
}

export function parseVaultContents(value: unknown, owner: VaultOwner): VaultContents {
  const v = value as VaultContents | null;
  if (!v || vaultIdentity(v.owner) !== vaultIdentity(owner) || !Array.isArray(v.accounts)
    || v.accounts.length < 1 || v.accounts.length > 50
    || (v.defaultAccountId !== null && typeof v.defaultAccountId !== 'string')) throw new Error('invalid_archive');
  const seen = new Set<string>();
  const accounts = v.accounts.map(a => {
    const identity = normalizeVaultOwner(a);
    const id = `${identity.username}@${new URL(identity.serverUrl).hostname}`;
    if (seen.has(id) || (a.password !== undefined && (typeof a.password !== 'string' || !a.password || a.password.length > 4096))
      || typeof a.label !== 'string' || a.label.length > 320
      || typeof a.avatarColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(a.avatarColor)) throw new Error('invalid_archive');
    seen.add(id);
    return { ...identity, ...(a.password === undefined ? {} : { password: a.password }), label: a.label, avatarColor: a.avatarColor };
  });
  if (!accounts.some(a => vaultIdentity(a) === vaultIdentity(owner))) throw new Error('invalid_archive');
  return { owner: normalizeVaultOwner(owner), accounts, defaultAccountId: v.defaultAccountId };
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('https_required');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function encryptVault(contents: VaultContents, password: string): Promise<VaultEnvelope> {
  if (password.length < 10 || password.length > 1024) throw new Error('password_length');
  const clean = parseVaultContents(contents, contents.owner);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`bulwark-account-vault:1:${vaultIdentity(clean.owner)}`),
  }, key, new TextEncoder().encode(JSON.stringify(clean)));
  return parseVaultEnvelope({ version: 1, iterations: 600000, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) });
}

export async function decryptVault(envelope: VaultEnvelope, password: string, owner: VaultOwner): Promise<VaultContents> {
  const clean = parseVaultEnvelope(envelope);
  if (password.length > 1024) throw new Error('password_length');
  const salt = decode(clean.salt);
  const iv = decode(clean.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('invalid_archive');
  const key = await deriveKey(password, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv,
      additionalData: new TextEncoder().encode(`bulwark-account-vault:1:${vaultIdentity(owner)}`),
    }, key, decode(clean.ciphertext));
  } catch { throw new Error('unlock_failed'); }
  try { return parseVaultContents(JSON.parse(new TextDecoder().decode(plaintext)), owner); }
  finally { new Uint8Array(plaintext).fill(0); }
}
