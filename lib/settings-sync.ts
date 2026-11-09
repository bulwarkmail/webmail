import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { getStore, type CollectionOptions } from '@/lib/shared-store';
import { isStoreUnavailable, isStoredDataUnreadable, StoredDataUnreadableError } from '@/lib/stored-data-errors';
import { moveUnreadableAside } from '@/lib/stored-data-quarantine';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

type Settings = Record<string, unknown>;

function getKey(): Buffer {
  const secret = getSessionSecret();
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return createHash('sha256').update(secret).digest();
}

export function getSettingsDir(): string {
  return process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings');
}

/** The document id of an account's settings: sha256 of `user:server`, hex. */
export function settingsId(username: string, serverUrl: string): string {
  return createHash('sha256').update(`${username}:${serverUrl}`).digest('hex');
}

const SETTINGS_FILE = /^[0-9a-f]{64}\.enc$/;

/**
 * One encrypted document per account (#1066). Local mode: today's
 * `<settings dir>/<id>.enc`, `iv‖tag‖ciphertext`. The account archives live
 * in a subfolder of the same dir and are not part of this collection.
 */
export const SETTINGS_COLLECTION: CollectionOptions = {
  local: {
    dir: () => getSettingsDir(),
    file: (id) => `${id}.enc`,
    idOf: (relative) => (SETTINGS_FILE.test(relative) ? relative.slice(0, -'.enc'.length) : null),
  },
};

function collection() {
  return getStore().collection('settings', SETTINGS_COLLECTION);
}

function encryptSettings(settings: Settings): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

/**
 * Settings from stored bytes. Too short to hold anything reads as nothing
 * stored, as it always has; bytes that don't decrypt throw
 * StoredDataUnreadableError.
 */
function decryptSettings(data: Buffer): Settings | null {
  if (data.length < IV_LENGTH + TAG_LENGTH) return null;
  const key = getKey();
  try {
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    logger.warn('Failed to decrypt user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    throw new StoredDataUnreadableError('settings', { cause: error });
  }
}

export async function saveUserSettings(username: string, serverUrl: string, settings: Settings): Promise<void> {
  await collection().put(settingsId(username, serverUrl), encryptSettings(settings));
}

/**
 * The user's stored settings, or null when none are stored. Settings that
 * don't decrypt (written with another session secret) read as none too; the
 * next save moves them aside before it writes (see updateUserSettings). A
 * file that can't be read throws StoredDataUnreadableError, a shared store
 * that can't be reached StoreUnavailableError.
 */
export async function loadUserSettings(username: string, serverUrl: string): Promise<Settings | null> {
  let stored;
  try {
    stored = await collection().get(settingsId(username, serverUrl));
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    logger.warn('Failed to read user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    throw new StoredDataUnreadableError('settings', { cause: error });
  }
  if (!stored) return null;
  try {
    return decryptSettings(stored.data);
  } catch (error) {
    if (isStoredDataUnreadable(error)) return null;
    throw error;
  }
}

/**
 * Read, change and write the user's settings in one step, so a save that
 * lands at the same time (another tab, another replica) isn't lost: `change`
 * gets what is stored now (null for nothing) and returns what to store. It
 * may run more than once.
 *
 * Stored settings that don't decrypt are moved aside first (kept next to
 * the original as `.unreadable-<time>`, never overwritten), and the save
 * goes on as if nothing was stored.
 */
export async function updateUserSettings(
  username: string,
  serverUrl: string,
  change: (stored: Settings | null) => Settings,
): Promise<void> {
  const docs = collection();
  const id = settingsId(username, serverUrl);
  for (let attempt = 0; ; attempt++) {
    try {
      await docs.update(id, (current) => encryptSettings(change(current ? decryptSettings(current) : null)));
      return;
    } catch (error) {
      if (!isStoredDataUnreadable(error) || attempt >= 2) throw error;
      const current = await docs.get(id);
      if (current) await moveUnreadableAside(docs, id, current, path.join(getSettingsDir(), `${id}.enc`), 'settings');
    }
  }
}

export async function deleteUserSettings(username: string, serverUrl: string): Promise<void> {
  try {
    await collection().delete(settingsId(username, serverUrl));
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    logger.warn('Failed to delete user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
