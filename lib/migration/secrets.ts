import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getSessionSecret } from '@/lib/auth/session-secret';

/**
 * Passwords the migration keeps (source passwords, the admin login of a
 * source, a user's app password) are encrypted inside their documents the
 * way synced settings are (lib/settings-sync.ts): AES-256-GCM with a key
 * from the session secret, `iv‖tag‖ciphertext`, here as base64 text.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const secret = getSessionSecret();
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** The secret, or null when it doesn't decrypt (another session secret, damaged). */
export function decryptSecret(stored: string | undefined | null): string | null {
  if (!stored) return null;
  const data = Buffer.from(stored, 'base64');
  if (data.length < IV_LENGTH + TAG_LENGTH) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), data.subarray(0, IV_LENGTH));
    decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    return Buffer.concat([decipher.update(data.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
