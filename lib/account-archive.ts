/**
 * Encrypted list of a user's accounts, kept on the server so another browser
 * can bring the same accounts back. Encryption happens in the browser with a
 * password the user chooses; the server only ever sees the envelope.
 *
 * The list holds no mailbox passwords: each restored account is signed in to
 * by hand.
 */

export interface ArchiveOwner { username: string; serverUrl: string }
export interface ArchivedAccount extends ArchiveOwner { label: string; avatarColor: string }
export interface ArchiveEnvelope {
  version: 1;
  iterations: typeof ARCHIVE_ITERATIONS;
  salt: string;
  iv: string;
  ciphertext: string;
}

export const ARCHIVE_ITERATIONS = 600000;
export const ARCHIVE_MAX_BYTES = 64 * 1024;
export const ARCHIVE_MAX_ACCOUNTS = 50;
export const ARCHIVE_MIN_PASSWORD = 10;

const trimUrl = (url: string) => url.replace(/\/+$/, '');

/**
 * One owner however the username is cased: `Lu@example.com` and
 * `lu@example.com` sign in to the same mailbox, so they share the archive.
 */
export function archiveIdentity(owner: ArchiveOwner): string {
  if (typeof owner?.username !== 'string' || !owner.username.trim() || owner.username.length > 320
    || typeof owner.serverUrl !== 'string' || !owner.serverUrl || owner.serverUrl.length > 2048) {
    throw new Error('invalid_archive');
  }
  return JSON.stringify([owner.username.trim().toLowerCase(), trimUrl(owner.serverUrl)]);
}

/** Strict allowlist: nothing but the envelope fields is stored or echoed. */
export function parseArchiveEnvelope(value: unknown): ArchiveEnvelope {
  const v = value as ArchiveEnvelope | null;
  const base64 = (s: unknown, bytes: (n: number) => boolean): s is string => {
    if (typeof s !== 'string' || s.length > ARCHIVE_MAX_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4) return false;
    try { return bytes(atob(s).length); } catch { return false; }
  };
  if (!v || typeof v !== 'object' || v.version !== 1 || v.iterations !== ARCHIVE_ITERATIONS
    || !base64(v.salt, n => n === 16) || !base64(v.iv, n => n === 12) || !base64(v.ciphertext, n => n > 16)) {
    throw new Error('invalid_archive');
  }
  return { version: 1, iterations: ARCHIVE_ITERATIONS, salt: v.salt, iv: v.iv, ciphertext: v.ciphertext };
}

export function parseArchivedAccounts(value: unknown): ArchivedAccount[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ARCHIVE_MAX_ACCOUNTS) throw new Error('invalid_archive');
  return value.map((a: ArchivedAccount) => {
    archiveIdentity(a);
    if (typeof a.label !== 'string' || a.label.length > 320
      || typeof a.avatarColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(a.avatarColor)) throw new Error('invalid_archive');
    // Rebuilt field by field, so nothing else (a password, say) survives a round trip.
    return { username: a.username.trim(), serverUrl: trimUrl(a.serverUrl), label: a.label, avatarColor: a.avatarColor };
  });
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
// The owner is sealed in: an envelope copied to another owner's slot will not open there.
const additionalData = (owner: ArchiveOwner) => new TextEncoder().encode(`bulwark-account-archive:1:${archiveIdentity(owner)}`);

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('https_required');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ARCHIVE_ITERATIONS },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptArchive(owner: ArchiveOwner, accounts: ArchivedAccount[], password: string): Promise<ArchiveEnvelope> {
  if (password.length < ARCHIVE_MIN_PASSWORD || password.length > 1024) throw new Error('password_length');
  const plaintext = new TextEncoder().encode(JSON.stringify({ accounts: parseArchivedAccounts(accounts) }));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(owner) }, key, plaintext);
  return parseArchiveEnvelope({ version: 1, iterations: ARCHIVE_ITERATIONS, salt: encode(salt), iv: encode(iv),
    ciphertext: encode(new Uint8Array(ciphertext)) });
}

export async function decryptArchive(owner: ArchiveOwner, envelope: ArchiveEnvelope, password: string): Promise<ArchivedAccount[]> {
  const clean = parseArchiveEnvelope(envelope);
  if (password.length > 1024) throw new Error('unlock_failed');
  const key = await deriveKey(password, decode(clean.salt));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(clean.iv), additionalData: additionalData(owner) },
      key, decode(clean.ciphertext));
  } catch { throw new Error('unlock_failed'); }
  return parseArchivedAccounts((JSON.parse(new TextDecoder().decode(plaintext)) as { accounts?: unknown }).accounts);
}
