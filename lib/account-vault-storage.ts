import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  legacyVaultIdentity, parseVaultEnvelope, parseVaultId, parseVaultName, vaultIdentity, VAULT_MAX_PER_OWNER,
  type VaultOwner, type VaultEnvelope, type VaultRecord,
} from './account-vault';

function identityDir(identity: string): string {
  const root = process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings');
  return path.join(root, 'account-vaults', createHash('sha256').update(identity).digest('hex'));
}
function ownerDir(owner: VaultOwner): string {
  return identityDir(vaultIdentity(owner));
}
/** Where this owner's archives sat when the username's case still told owners apart. */
function legacyOwnerDir(owner: VaultOwner): string | null {
  const legacy = legacyVaultIdentity(owner);
  return legacy === vaultIdentity(owner) ? null : identityDir(legacy);
}
const ARCHIVE_FILE = /^([a-f0-9]{32})\.json$/;
function filePath(owner: VaultOwner, id: string): string {
  return path.join(ownerDir(owner), parseVaultId(id) + '.json');
}
function toRecord(id: string, text: string): VaultRecord {
  const stored = JSON.parse(text) as { name?: unknown; envelope?: unknown; sealedAs?: unknown } | null;
  const sealedAs = typeof stored?.sealedAs === 'string' && stored.sealedAs.length <= 2400 ? stored.sealedAs : undefined;
  return { id, name: parseVaultName(stored?.name), revision: createHash('sha256').update(text).digest('hex'),
    envelope: parseVaultEnvelope(stored?.envelope), ...(sealedAs === undefined ? {} : { sealedAs }) };
}

export async function loadVault(owner: VaultOwner, id: string): Promise<VaultRecord | null> {
  try { return toRecord(id, await readFile(filePath(owner, id), 'utf8')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Name given to an archive written by the single-archive format (one `<owner-hash>.json` file). */
export const LEGACY_VAULT_NAME = 'Saved accounts';

/** Moves a single-archive-format file into the owner directory, once, so it keeps showing up. */
async function migrateLegacy(owner: VaultOwner): Promise<void> {
  // Either hash may hold one: the file predates both the per-owner directory
  // and the case-folded identity.
  for (const dir of [ownerDir(owner), legacyOwnerDir(owner)]) {
    if (dir !== null) await migrateLegacyFile(owner, dir + '.json');
  }
}
async function migrateLegacyFile(owner: VaultOwner, legacy: string): Promise<void> {
  let text: string;
  try { text = await readFile(legacy, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await withOwnerLock(owner, async dir => {
    // Another process may have migrated it while we waited for the lock.
    try { await readFile(legacy, 'utf8'); } catch { return; }
    const serialized = JSON.stringify({ name: LEGACY_VAULT_NAME, envelope: parseVaultEnvelope(JSON.parse(text)),
      // A single-archive file found under the case-sensitive hash was sealed with it.
      ...(legacy === ownerDir(owner) + '.json' ? {} : { sealedAs: legacyVaultIdentity(owner) }) });
    await writeFileExclusive(path.join(dir, randomBytes(16).toString('hex') + '.json'), serialized);
    await unlink(legacy);
  });
}

/**
 * Rehomes archives saved when `Lu@ma.gl` and `lu@ma.gl` were separate owners.
 *
 * Only a session whose username hashes to the old directory can reach it, so
 * moving its archives under the case-folded identity hands them to the one
 * owner entitled to them. The destination is written before the source is
 * removed: an interrupted migration leaves a duplicate, never a gap.
 */
async function migrateCase(owner: VaultOwner): Promise<void> {
  const legacy = legacyOwnerDir(owner);
  if (legacy === null) return;
  let entries: string[];
  try { entries = await readdir(legacy); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const ids = entries.flatMap(entry => ARCHIVE_FILE.exec(entry)?.[1] ?? []);
  if (!ids.length) { await rmdir(legacy).catch(() => {}); return; }
  await withOwnerLock(owner, async dir => {
    let room = VAULT_MAX_PER_OWNER - (await readVaults(owner)).length;
    for (const id of ids) {
      // Over the limit the rest stay where they are: an archive is never
      // dropped to make the move fit.
      if (room <= 0) break;
      const source = path.join(legacy, id + '.json');
      // An id already taken in the destination is astronomically unlikely, but
      // both writes below refuse to clobber, so it renames instead of losing one.
      const names = [id + '.json', randomBytes(16).toString('hex') + '.json'];
      let moved = false;
      for (const name of names) {
        // The archive is sealed with the identity it was saved under, which the
        // owner can no longer derive: record it so unlocking still works. A file
        // that will not parse is moved verbatim rather than left behind.
        let rewritten: string | null = null;
        try {
          const stored = JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>;
          rewritten = JSON.stringify({ name: parseVaultName(stored?.name), envelope: parseVaultEnvelope(stored?.envelope),
            sealedAs: legacyVaultIdentity(owner) });
        } catch { /* unreadable or unrecognized: fall back to linking it across */ }
        try {
          if (rewritten === null) await link(source, path.join(dir, name));
          else await writeFileExclusive(path.join(dir, name), rewritten);
          moved = true;
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // Gone already: a concurrent migration moved it, and nothing is left to remove.
          if (code === 'ENOENT') { moved = true; break; }
          // Only a taken name is worth retrying under the next one.
          if (code !== 'EEXIST') throw err;
        }
      }
      // A source that could not be placed stays put rather than disappearing.
      if (moved) await unlink(source).catch(() => {});
      room--;
    }
  });
  await rmdir(legacy).catch(() => { /* leftovers above the limit, or a concurrent writer */ });
}

/** Archives as they sit on disk, without running any migration. */
async function readVaults(owner: VaultOwner): Promise<VaultRecord[]> {
  let entries: string[];
  try { entries = await readdir(ownerDir(owner)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const ids = entries.flatMap(entry => ARCHIVE_FILE.exec(entry)?.[1] ?? []);
  // A file deleted between readdir and read simply drops out of the list.
  const records = (await Promise.all(ids.map(id => loadVault(owner, id)))).filter(r => r !== null);
  return records.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function listVaults(owner: VaultOwner): Promise<VaultRecord[]> {
  // A writer holding the lock only defers a migration to the next listing; it
  // must not turn reading the archives into a failure.
  const deferOnConflict = (err: unknown) => { if (!(err instanceof VaultConflict)) throw err; };
  await migrateLegacy(owner).catch(deferOnConflict);
  await migrateCase(owner).catch(deferOnConflict);
  return readVaults(owner);
}

/** Creates the file or fails with EEXIST; never truncates an existing archive. */
async function writeFileExclusive(target: string, text: string): Promise<void> {
  const file = await open(target, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); }
  finally { await file.close(); }
}

export class VaultConflict extends Error {}
export class VaultLimit extends Error {}

/** One lock per owner serializes create, replace and delete, including across processes sharing the volume. */
async function withOwnerLock<T>(owner: VaultOwner, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = ownerDir(owner);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultConflict();
    throw err;
  }
  try { return await fn(dir); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Creates a new archive when `id` is null, otherwise compare-and-swaps the existing one. */
export async function saveVault(owner: VaultOwner, id: string | null, name: string, envelope: VaultEnvelope, revision: string | null): Promise<VaultRecord> {
  const clean = { name: parseVaultName(name), envelope: parseVaultEnvelope(envelope) };
  const existingId = id === null ? null : parseVaultId(id);
  return withOwnerLock(owner, async () => {
    let archiveId: string;
    if (existingId === null) {
      if (revision !== null) throw new VaultConflict();
      if ((await readVaults(owner)).length >= VAULT_MAX_PER_OWNER) throw new VaultLimit();
      archiveId = randomBytes(16).toString('hex');
    } else {
      const current = await loadVault(owner, existingId);
      if (!current || current.revision !== revision) throw new VaultConflict();
      archiveId = existingId;
    }
    const target = filePath(owner, archiveId);
    const temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp';
    const serialized = JSON.stringify(clean);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return toRecord(archiveId, serialized);
  });
}

export async function deleteVault(owner: VaultOwner, id: string, revision: string): Promise<void> {
  const target = filePath(owner, id);
  await withOwnerLock(owner, async () => {
    const current = await loadVault(owner, id);
    if (!current || current.revision !== revision) throw new VaultConflict();
    await unlink(target);
  });
}
