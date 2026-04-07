import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { logger } from '@/lib/logger';
import { readFileEnv } from '@/lib/read-file-env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const MIN_SECRET_LENGTH = 32;

function getKey(): Buffer {
  const secret =  process.env.SESSION_SECRET || readFileEnv(process.env.SESSION_SECRET_FILE);
  if (!secret) throw new Error('SESSION_SECRET not configured');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return createHash('sha256').update(secret).digest();
}

export function encryptSession(serverUrl: string, username: string, password: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const payload = JSON.stringify({ v: 1, serverUrl, username, password });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSession(token: string): { serverUrl: string; username: string; password: string } | null {
  try {
    const key = getKey();
    const data = Buffer.from(token, 'base64');
    if (data.length < IV_LENGTH + TAG_LENGTH) return null;

    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString('utf8'));

    if (parsed.v !== 1 || !parsed.serverUrl || !parsed.username || !parsed.password) return null;
    return { serverUrl: parsed.serverUrl, username: parsed.username, password: parsed.password };
  } catch (error) {
    logger.warn('Session decryption failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

export function encryptPayload(payload: Record<string, unknown>): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const json = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptPayload(token: string): Record<string, unknown> | null {
  try {
    const key = getKey();
    const data = Buffer.from(token, 'base64');
    if (data.length < IV_LENGTH + TAG_LENGTH) return null;

    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    logger.warn('Payload decryption failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}
