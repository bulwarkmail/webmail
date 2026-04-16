import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/logger';
import type { AdminData } from './types';

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // 2^14
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SALT_LENGTH = 32;

function getAdminDir(): string {
  return process.env.ADMIN_DATA_DIR || path.join(process.cwd(), 'data', 'admin');
}

function getAdminJsonPath(): string {
  return path.join(getAdminDir(), 'admin.json');
}

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(SALT_LENGTH);
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION }, (err, derivedKey) => {
      if (err) return reject(err);
      // Format: $scrypt$N=16384,r=8,p=1$<salt_base64>$<hash_base64>
      const params = `N=${SCRYPT_COST},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELIZATION}`;
      resolve(`$scrypt$${params}$${salt.toString('base64')}$${derivedKey.toString('base64')}`);
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // Support both scrypt format and bcrypt-prefixed values
    if (stored.startsWith('$scrypt$')) {
      const parts = stored.split('$');
      // $scrypt$N=...,r=...,p=...$salt$hash
      if (parts.length !== 5) return resolve(false);
      const paramStr = parts[2];
      const salt = Buffer.from(parts[3], 'base64');
      const storedHash = Buffer.from(parts[4], 'base64');

      const params: Record<string, number> = {};
      for (const p of paramStr.split(',')) {
        const [k, v] = p.split('=');
        params[k] = parseInt(v, 10);
      }

      scrypt(password, salt, storedHash.length, { N: params.N, r: params.r, p: params.p }, (err, derivedKey) => {
        if (err) return reject(err);
        resolve(timingSafeEqual(derivedKey, storedHash));
      });
    } else {
      // Unknown format
      resolve(false);
    }
  });
}

function isHashed(value: string): boolean {
  return value.startsWith('$scrypt$') || value.startsWith('$2a$') || value.startsWith('$2b$');
}

async function readAdminData(): Promise<AdminData | null> {
  const filePath = getAdminJsonPath();
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as AdminData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn('Failed to read admin.json', { error: error instanceof Error ? error.message : 'Unknown error' });
    return null;
  }
}

async function writeAdminData(data: AdminData): Promise<void> {
  const dir = getAdminDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const targetPath = getAdminJsonPath();
  const tmpPath = targetPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, targetPath);
}

let cachedAdminData: AdminData | null = null;
let initialized = false;

/**
 * Initialize admin password on startup.
 * If ADMIN_PASSWORD is cleartext, hash it and write to admin.json.
 * Returns true if admin is enabled.
 */
export async function initAdminPassword(): Promise<boolean> {
  if (initialized) return cachedAdminData !== null;

  // Check persistent file first
  const existing = await readAdminData();
  if (existing) {
    cachedAdminData = existing;
    initialized = true;
    logger.info('Admin dashboard enabled (password loaded from admin.json)');
    return true;
  }

  // Check env var
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword) {
    initialized = true;
    logger.info('Admin dashboard disabled (no ADMIN_PASSWORD set)');
    return false;
  }

  if (isHashed(envPassword)) {
    // Already hashed in env - save to file
    const data: AdminData = {
      passwordHash: envPassword,
      createdAt: new Date().toISOString(),
      lastLogin: null,
      passwordChangedAt: new Date().toISOString(),
    };
    await writeAdminData(data);
    cachedAdminData = data;
    initialized = true;
    logger.info('Admin password hash saved to admin.json from environment variable');
    return true;
  }

  // Cleartext - hash it
  const hash = await hashPassword(envPassword);
  const data: AdminData = {
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    passwordChangedAt: new Date().toISOString(),
  };
  await writeAdminData(data);
  cachedAdminData = data;
  initialized = true;
  logger.warn('Admin password hashed and saved to admin.json. You may now remove ADMIN_PASSWORD from .env');
  return true;
}

/**
 * Verify a password against the stored admin hash.
 */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (!cachedAdminData) {
    cachedAdminData = await readAdminData();
  }
  if (!cachedAdminData) return false;
  return verifyPassword(password, cachedAdminData.passwordHash);
}

/**
 * Change the admin password. Returns true on success.
 */
export async function changeAdminPassword(currentPassword: string, newPassword: string): Promise<boolean> {
  const valid = await verifyAdminPassword(currentPassword);
  if (!valid) return false;

  const hash = await hashPassword(newPassword);
  if (!cachedAdminData) return false;

  cachedAdminData = {
    ...cachedAdminData,
    passwordHash: hash,
    passwordChangedAt: new Date().toISOString(),
  };
  await writeAdminData(cachedAdminData);
  return true;
}

/**
 * Update the last login timestamp.
 */
export async function updateLastLogin(): Promise<void> {
  if (!cachedAdminData) return;
  cachedAdminData = {
    ...cachedAdminData,
    lastLogin: new Date().toISOString(),
  };
  await writeAdminData(cachedAdminData);
}

/**
 * Check if admin dashboard is enabled (has a password configured).
 */
export function isAdminEnabled(): boolean {
  return cachedAdminData !== null;
}

/**
 * Get admin metadata (without the hash).
 */
export function getAdminMeta(): { createdAt: string; lastLogin: string | null; passwordChangedAt: string } | null {
  if (!cachedAdminData) return null;
  return {
    createdAt: cachedAdminData.createdAt,
    lastLogin: cachedAdminData.lastLogin,
    passwordChangedAt: cachedAdminData.passwordChangedAt,
  };
}
