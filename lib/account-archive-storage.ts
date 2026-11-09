import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getStore, isSharedMode, type CollectionOptions } from '@/lib/shared-store';
import { archiveIdentity, parseArchiveEnvelope, type ArchiveEnvelope, type ArchiveOwner } from './account-archive';

/** One file per owner: `SETTINGS_DATA_DIR/account-archives/<sha256 of the owner>.json`. */
function archiveDir(): string {
  return path.join(process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings'), 'account-archives');
}

const ARCHIVE_FILE = /^[0-9a-f]{64}\.json$/;

/**
 * One document per owner (#1066), replaced whole on every save. Local mode:
 * today's files, mode 0600. The archive is encrypted in the browser with
 * the user's password; the server holds no key.
 */
export const ARCHIVE_COLLECTION: CollectionOptions = {
  local: {
    dir: archiveDir,
    file: (id) => `${id}.json`,
    idOf: (relative) => (ARCHIVE_FILE.test(relative) ? relative.slice(0, -'.json'.length) : null),
    mode: 0o600,
    // Written to disk before the rename, as it always was.
    fsync: true,
  },
};

function collection() {
  return getStore().collection('account-archives', ARCHIVE_COLLECTION);
}

function archiveId(owner: ArchiveOwner): string {
  return createHash('sha256').update(archiveIdentity(owner)).digest('hex');
}

export async function loadArchive(owner: ArchiveOwner): Promise<ArchiveEnvelope | null> {
  const stored = await collection().get(archiveId(owner));
  return stored ? parseArchiveEnvelope(JSON.parse(stored.data.toString('utf8'))) : null;
}

/** Replaces the owner's archive atomically: a reader sees the old one or the new one, never half of it. */
export async function saveArchive(owner: ArchiveOwner, envelope: ArchiveEnvelope): Promise<void> {
  const data = JSON.stringify(parseArchiveEnvelope(envelope));
  // The folder only its owner may list, as it has always been created.
  if (!isSharedMode()) await mkdir(archiveDir(), { recursive: true, mode: 0o700 });
  await collection().put(archiveId(owner), data);
}

export async function deleteArchive(owner: ArchiveOwner): Promise<void> {
  await collection().delete(archiveId(owner));
}
