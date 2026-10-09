import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { archiveIdentity, parseArchiveEnvelope, type ArchiveEnvelope, type ArchiveOwner } from './account-archive';

/** One file per owner: `SETTINGS_DATA_DIR/account-archives/<sha256 of the owner>.json`. */
function archiveDir(): string {
  return path.join(process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings'), 'account-archives');
}
function archivePath(owner: ArchiveOwner): string {
  return path.join(archiveDir(), createHash('sha256').update(archiveIdentity(owner)).digest('hex') + '.json');
}

export async function loadArchive(owner: ArchiveOwner): Promise<ArchiveEnvelope | null> {
  try { return parseArchiveEnvelope(JSON.parse(await readFile(archivePath(owner), 'utf8'))); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Replaces the owner's archive atomically: a reader sees the old file or the new one, never half of it. */
export async function saveArchive(owner: ArchiveOwner, envelope: ArchiveEnvelope): Promise<void> {
  const target = archivePath(owner);
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  await mkdir(archiveDir(), { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(parseArchiveEnvelope(envelope))); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function deleteArchive(owner: ArchiveOwner): Promise<void> {
  await unlink(archivePath(owner)).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
}
