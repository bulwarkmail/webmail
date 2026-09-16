import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  parseVaultEnvelope, parseVaultId, parseVaultName, vaultIdentity, VAULT_MAX_PER_OWNER,
  type VaultOwner, type VaultEnvelope, type VaultRecord,
} from './account-vault';

function ownerDir(owner: VaultOwner): string {
  const root = process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings');
  return path.join(root, 'account-vaults', createHash('sha256').update(vaultIdentity(owner)).digest('hex'));
}
function filePath(owner: VaultOwner, id: string): string {
  return path.join(ownerDir(owner), parseVaultId(id) + '.json');
}
function toRecord(id: string, text: string): VaultRecord {
  const stored = JSON.parse(text) as { name?: unknown; envelope?: unknown } | null;
  return { id, name: parseVaultName(stored?.name), revision: createHash('sha256').update(text).digest('hex'),
    envelope: parseVaultEnvelope(stored?.envelope) };
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
  const legacy = ownerDir(owner) + '.json';
  let text: string;
  try { text = await readFile(legacy, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await withOwnerLock(owner, async dir => {
    // Another process may have migrated it while we waited for the lock.
    try { await readFile(legacy, 'utf8'); } catch { return; }
    const serialized = JSON.stringify({ name: LEGACY_VAULT_NAME, envelope: parseVaultEnvelope(JSON.parse(text)) });
    const target = path.join(dir, randomBytes(16).toString('hex') + '.json');
    const file = await open(target, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    await unlink(legacy);
  });
}

export async function listVaults(owner: VaultOwner): Promise<VaultRecord[]> {
  await migrateLegacy(owner);
  let entries: string[];
  try { entries = await readdir(ownerDir(owner)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const ids = entries.flatMap(entry => /^([a-f0-9]{32})\.json$/.exec(entry)?.[1] ?? []);
  // A file deleted between readdir and read simply drops out of the list.
  const records = (await Promise.all(ids.map(id => loadVault(owner, id)))).filter(r => r !== null);
  return records.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
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
      if ((await listVaults(owner)).length >= VAULT_MAX_PER_OWNER) throw new VaultLimit();
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
