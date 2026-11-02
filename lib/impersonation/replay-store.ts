import { createHash } from 'node:crypto';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getStatePath } from '@/lib/admin/paths';
import { logger } from '@/lib/logger';
import { getStore, isSharedMode } from '@/lib/shared-store';
import { IMPERSONATION_REPLAY_WINDOW_SEC, impersonationReplayCache } from './jwt';

const STORE_DIR = 'impersonation-jti';

function markerName(jti: string): string {
  return createHash('sha256').update(jti).digest('hex');
}

/** The used jti's key in the shared store (#1066); it expires with the token. */
const sharedKey = (jti: string) => `imp-jti:${markerName(jti)}`;

/** The use of a token couldn't be recorded: it is refused, and the route answers 503. */
export class ImpersonationReplayUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The impersonation replay store is unavailable', options);
    this.name = 'ImpersonationReplayUnavailableError';
  }
}

/** By name, as every bundle has its own copy of the class. */
export function isImpersonationReplayUnavailable(error: unknown): boolean {
  return (error as Error | null)?.name === 'ImpersonationReplayUnavailableError';
}

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
 * Rejects with ImpersonationReplayUnavailableError when the use can't be
 * recorded: the token is refused then, as a restart or another replica
 * would otherwise accept it again.
 *
 * The in-process cache alone forgot every jti on restart and knew nothing of
 * other replicas, so a captured handoff link could be redeemed again within
 * its lifetime. Each jti also gets a marker file in the state directory,
 * created with O_EXCL, which survives restarts and is shared by every
 * replica that mounts the same state volume. Markers are pruned once the
 * token they stand for can no longer verify. With a shared store the marker
 * is a key there, set only if missing and expiring with the token, so
 * exactly one replica accepts the token. The in-process cache learns a jti
 * only once it was recorded.
 */
export async function consumeImpersonationJti(
  jti: string,
  exp: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const nowSec = Math.floor(nowMs / 1000);
  if (impersonationReplayCache.has(jti, nowSec)) return false;
  if (!(await recordUse(jti, nowMs))) return false;
  impersonationReplayCache.consume(jti, exp, nowSec);
  return true;
}

/** True when this call recorded the jti, false when it was recorded before. */
async function recordUse(jti: string, nowMs: number): Promise<boolean> {
  if (isSharedMode()) {
    try {
      return await getStore().kv.set(sharedKey(jti), '1', { ifAbsent: true, ttlMs: IMPERSONATION_REPLAY_WINDOW_SEC * 1000 });
    } catch (err) {
      logger.error('Impersonation replay store unavailable, refusing the token', {
        error: err instanceof Error ? err.message : 'Unknown',
      });
      throw new ImpersonationReplayUnavailableError({ cause: err });
    }
  }

  const dir = getStatePath(STORE_DIR);
  try {
    await mkdir(dir, { recursive: true });
    await pruneExpired(dir, nowMs);
    const marker = await open(path.join(dir, markerName(jti)), 'wx');
    await marker.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // Without the marker a restart or another replica would accept the
    // token again, so it is refused rather than trusted to this process's
    // memory.
    logger.error('Impersonation replay store unavailable, refusing the token', {
      error: err instanceof Error ? err.message : 'Unknown',
    });
    throw new ImpersonationReplayUnavailableError({ cause: err });
  }
}
