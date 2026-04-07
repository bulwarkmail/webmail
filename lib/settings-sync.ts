import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { readFileEnv } from '@/lib/read-file-env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET || readFileEnv(process.env.SESSION_SECRET_FILE);
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return createHash('sha256').update(secret).digest();
}

function getSettingsDir(): string {
  return process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings');
}

function getSettingsPath(username: string, serverUrl: string): string {
  const hash = createHash('sha256').update(`${username}:${serverUrl}`).digest('hex');
  const filePath = path.join(getSettingsDir(), `${hash}.enc`);
  // Defense in depth: ensure path stays within the settings directory
  const resolvedDir = path.resolve(getSettingsDir());
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
    throw new Error('Invalid settings path');
  }
  return resolvedPath;
}

export async function saveUserSettings(username: string, serverUrl: string, settings: Record<string, unknown>): Promise<void> {
  const dir = getSettingsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const payload = JSON.stringify(settings);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const data = Buffer.concat([iv, tag, encrypted]);
  const targetPath = getSettingsPath(username, serverUrl);
  const tmpPath = targetPath + '.tmp';
  await writeFile(tmpPath, data);
  await rename(tmpPath, targetPath);
}

export async function loadUserSettings(username: string, serverUrl: string): Promise<Record<string, unknown> | null> {
  const filePath = getSettingsPath(username, serverUrl);

  try {
    const data = await readFile(filePath);
    if (data.length < IV_LENGTH + TAG_LENGTH) return null;

    const key = getKey();
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn('Failed to load user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    return null;
  }
}

export async function deleteUserSettings(username: string, serverUrl: string): Promise<void> {
  try {
    await unlink(getSettingsPath(username, serverUrl));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to delete user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}
