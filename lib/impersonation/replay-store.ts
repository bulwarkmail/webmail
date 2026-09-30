import { createHash } from 'node:crypto';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getStatePath } from '@/lib/admin/paths';
import { logger } from '@/lib/logger';
import { IMPERSONATION_REPLAY_WINDOW_SEC, impersonationReplayCache } from './jwt';

const STORE_DIR = 'impersonation-jti';

async function pruneExpired(dir: string, nowMs: number): Promise<void> {
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    try {
      const { mtimeMs } = await stat(file);
      if (nowMs - mtimeMs > IMPERSONATION_REPLAY_WINDOW_SEC * 1000) await unlink(file);
    } catch {
      // Another process pruned it first.
    }
  }
}

/**
 * Record an impersonation token's jti as used; false when it was used before.
 *
 * The in-process cache alone forgot every jti on restart and knew nothing of
 * other replicas, so a captured handoff link could be redeemed again within
 * its lifetime. Each jti also gets a marker file in the state directory,
 * created with O_EXCL, which survives restarts and is shared by every
 * replica that mounts the same state volume. Markers are pruned once the
 * token they stand for can no longer verify.
 */
export async function consumeImpersonationJti(
  jti: string,
  exp: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!impersonationReplayCache.consume(jti, exp, Math.floor(nowMs / 1000))) return false;

  const dir = getStatePath(STORE_DIR);
  try {
    await mkdir(dir, { recursive: true });
    await pruneExpired(dir, nowMs);
    const marker = await open(path.join(dir, createHash('sha256').update(jti).digest('hex')), 'wx');
    await marker.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // The state directory is documented as always writable; if it is not,
    // keep impersonation working on the in-process cache.
    logger.warn('Impersonation replay store unavailable, using the in-process cache only', {
      error: err instanceof Error ? err.message : 'Unknown',
    });
    return true;
  }
}
