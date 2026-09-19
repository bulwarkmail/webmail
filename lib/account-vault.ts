import { parseAccountTheme, parseDisplaySettings, type AccountTheme, type DisplaySettings } from './display-preferences';

/** Portable archive format. Only encrypted envelopes may cross the storage API. */
export interface VaultOwner { username: string; serverUrl: string }
export interface VaultAccount extends VaultOwner {
  password?: string;
  label: string;
  avatarColor: string;
  /** Data URI as produced by the avatar upload (128x128 WebP). */
  avatarImage?: string;
  /** This account's display profile, so a new device looks like the old one. */
  display?: Partial<DisplaySettings>;
  theme?: AccountTheme;
}
export interface VaultContents {
  owner: VaultOwner;
  accounts: VaultAccount[];
  defaultAccountId: string | null;
  /** Account whose display profile the others follow, when sharing is on. */
  sharedDisplaySourceId?: string | null;
}
export interface VaultEnvelope {
  version: 1;
  iterations: 600000;
  salt: string;
  iv: string;
  ciphertext: string;
}
/** One owner may keep several archives; the name is plaintext so it can be picked before unlocking. */
export interface VaultRecord { id: string; name: string; revision: string; envelope: VaultEnvelope }
// Archives carry avatars and display profiles, not just credentials. A 128x128
// WebP avatar is a few KB, but base64 inside JSON inside the envelope adds up.
export const VAULT_MAX_BYTES = 1024 * 1024;
/** One avatar may not crowd out the rest of the archive. */
export const VAULT_AVATAR_MAX_CHARS = 64 * 1024;
export const VAULT_MAX_PER_OWNER = 10;
export const VAULT_NAME_MAX = 80;

export function parseVaultName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > VAULT_NAME_MAX || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new Error('invalid_name');
  }
  return name;
}

export function parseVaultId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('invalid_archive');
  return value;
}

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

/** Only the data URIs the avatar upload itself produces are accepted back. */
function parseVaultAvatar(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > VAULT_AVATAR_MAX_CHARS
    || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid_archive');
  return value;
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
    const avatarImage = parseVaultAvatar(a.avatarImage);
    const display = parseDisplaySettings(a.display);
    const theme = parseAccountTheme(a.theme);
    // Presentation is best-effort: a profile that fails validation is dropped,
    // never a reason to refuse an archive that can still restore the account.
    return { ...identity, ...(a.password === undefined ? {} : { password: a.password }), label: a.label, avatarColor: a.avatarColor,
      ...(avatarImage === undefined ? {} : { avatarImage }),
      ...(display === undefined ? {} : { display }),
      ...(theme === undefined ? {} : { theme }) };
  });
  if (!accounts.some(a => vaultIdentity(a) === vaultIdentity(owner))) throw new Error('invalid_archive');
  // Absent stays absent: an archive written before appearance travelled with
  // accounts must round-trip unchanged.
  const shared = v.sharedDisplaySourceId === undefined ? undefined
    : typeof v.sharedDisplaySourceId === 'string' && v.sharedDisplaySourceId.length <= 320 ? v.sharedDisplaySourceId : null;
  return { owner: normalizeVaultOwner(owner), accounts, defaultAccountId: v.defaultAccountId,
    ...(shared === undefined ? {} : { sharedDisplaySourceId: shared }) };
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
