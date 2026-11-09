import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { isSharedMode } from '@/lib/shared-store';
import { versionOf } from '@/lib/shared-store/keys';
import { serializeLocal } from '@/lib/shared-store/local';
import type { DocCollection, StoredDoc } from '@/lib/shared-store/types';

/**
 * Put a user's document that no longer decrypts out of the way, so the
 * user can save again, without losing its bytes (#1066). It most likely was
 * written with another session secret (rotated, or a replica that had its
 * own); with that secret back it can be restored by hand.
 *
 * - Local mode: renamed to `<file>.unreadable-<time>` next to it.
 * - Shared mode: copied to `<id>.unreadable-<time>`, then the original is
 *   deleted, only if it is still the same document.
 *
 * Either way a concurrent write that replaced it meanwhile is left alone.
 */
export async function moveUnreadableAside(
  docs: DocCollection,
  id: string,
  current: StoredDoc,
  localFile: string,
  what: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!isSharedMode()) {
    const file = path.resolve(localFile);
    const target = `${file}.unreadable-${stamp}`;
    // On the collection's own queue for this file, so no write lands between
    // the check and the rename.
    const moved = await serializeLocal(`doc\0${file}`, async () => {
      const now = await readFile(file).catch(() => null);
      if (!now || versionOf(now) !== current.version) return false;
      await rename(file, target);
      return true;
    });
    if (moved) logger.warn(`Moved aside stored ${what} that could not be decrypted`, { path: target });
    return;
  }
  const aside = `${id}.unreadable-${stamp}`;
  await docs.put(aside, current.data, { ifVersion: null });
  if (await docs.delete(id, { ifVersion: current.version })) {
    logger.warn(`Moved aside stored ${what} that could not be decrypted`, { collection: docs.name, id: aside });
  } else {
    await docs.delete(aside).catch(() => {});
  }
}
