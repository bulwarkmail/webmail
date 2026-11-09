import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { logger } from '@/lib/logger';
import { ensureStateDir, getStatePath } from '@/lib/admin/paths';
import { getStore, isSharedMode } from '@/lib/shared-store';

const TOKEN_FILE = '.setup-token';
const TOKEN_BYTES = 32;
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

interface TokenPayload {
  token: string;
  issuedAt: number;
  ttlSeconds: number;
}

/**
 * With a shared store (#1066) the token lives there instead of in the state
 * dir, so every replica prints the same one and the wizard works through
 * any of them. The payload keeps its own issuedAt and TTL; the store's
 * expiry only cleans up, a minute later.
 */
const SHARED_KEY = 'setup-token';
const SHARED_CLEANUP_GRACE_MS = 60_000;

function isExpired(payload: TokenPayload): boolean {
  return Date.now() / 1000 - payload.issuedAt > payload.ttlSeconds;
}

function parseShared(raw: string): TokenPayload | null {
  try {
    const payload = JSON.parse(raw) as TokenPayload;
    if (typeof payload?.token !== 'string' || typeof payload.issuedAt !== 'number' || typeof payload.ttlSeconds !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
}

async function readSharedToken(): Promise<TokenPayload | null> {
  const kv = getStore().kv;
  const raw = await kv.get(SHARED_KEY);
  if (raw === null) return null;
  const payload = parseShared(raw);
  if (payload && !isExpired(payload)) return payload;
  // Expired (or unreadable): drop it, unless another replica replaced it meanwhile.
  await kv.update(SHARED_KEY, (current) => (current === raw ? null : undefined));
  return null;
}

async function ensureSharedSetupToken(ttlSeconds: number): Promise<string> {
  const existing = await readSharedToken();
  if (existing) return existing.token;
  const payload: TokenPayload = {
    token: randomBytes(TOKEN_BYTES).toString('hex'),
    issuedAt: Math.floor(Date.now() / 1000),
    ttlSeconds,
  };
  // Replicas booting together: the first one's token is the one.
  await getStore().kv.set(SHARED_KEY, JSON.stringify(payload), {
    ifAbsent: true,
    ttlMs: ttlSeconds * 1000 + SHARED_CLEANUP_GRACE_MS,
  });
  const stored = await readSharedToken();
  if (!stored) throw new Error('The shared store did not keep the setup token');
  return stored.token;
}

/**
 * Read the current token if one exists and hasn't expired. Stale tokens
 * are deleted lazily - first stale read removes the file.
 */
async function readToken(): Promise<TokenPayload | null> {
  if (isSharedMode()) return readSharedToken();
  const path = getStatePath(TOKEN_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const payload = JSON.parse(raw) as TokenPayload;
    if (Date.now() / 1000 - payload.issuedAt > payload.ttlSeconds) {
      try { await unlink(path); } catch { /* ok */ }
      return null;
    }
    return payload;
  } catch (error) {
    logger.warn('Failed to read setup token', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Generate (or refresh) the setup token. Called at startup when the app
 * detects bootstrap state. Idempotent: returns the existing token if it's
 * still valid, otherwise issues a fresh one.
 *
 * The token lands in a file in ADMIN_STATE_DIR (always writable, never
 * read-only) and is also printed to the container logs so the operator
 * can copy it without execing into the container.
 */
export async function ensureSetupToken(ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<string> {
  if (isSharedMode()) return ensureSharedSetupToken(ttlSeconds);
  const existing = await readToken();
  if (existing) return existing.token;

  await ensureStateDir();
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const payload: TokenPayload = {
    token,
    issuedAt: Math.floor(Date.now() / 1000),
    ttlSeconds,
  };
  const path = getStatePath(TOKEN_FILE);
  // Owner-only: whoever reads it can finish the setup wizard.
  await writeFile(path, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return token;
}

/**
 * Verify a token submitted by the wizard. Constant-time comparison; never
 * leak the stored token via timing.
 */
export async function verifySetupToken(submitted: string): Promise<boolean> {
  if (!submitted || typeof submitted !== 'string') return false;
  const stored = await readToken();
  if (!stored) return false;

  const a = Buffer.from(submitted);
  const b = Buffer.from(stored.token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Delete the token file. Called by the wizard's finish endpoint after
 * setupComplete=true is persisted.
 */
export async function clearSetupToken(): Promise<void> {
  if (isSharedMode()) {
    await getStore().kv.del(SHARED_KEY);
    return;
  }
  const path = getStatePath(TOKEN_FILE);
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn('Failed to clear setup token', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
