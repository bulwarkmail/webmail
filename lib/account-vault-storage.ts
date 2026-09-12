import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseVaultEnvelope, vaultIdentity, type VaultOwner, type VaultEnvelope, type VaultRecord } from './account-vault';

function filePath(owner: VaultOwner): string {
  const root = process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings');
  return path.join(root, 'account-vaults', createHash('sha256').update(vaultIdentity(owner)).digest('hex') + '.json');
}

export async function loadVault(owner: VaultOwner): Promise<VaultRecord | null> {
  try {
    const text = await readFile(filePath(owner), 'utf8');
    return { revision: createHash('sha256').update(text).digest('hex'), envelope: parseVaultEnvelope(JSON.parse(text)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class VaultConflict extends Error {}

/** File lock + compare-and-swap, including across processes sharing the volume. */
export async function saveVault(owner: VaultOwner, envelope: VaultEnvelope, revision: string | null): Promise<VaultRecord> {
  const clean = parseVaultEnvelope(envelope);
  const target = filePath(owner);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(target + '.lock', 'wx', 0o600); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultConflict();
    throw err;
  }
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    const current = await loadVault(owner);
    if ((current?.revision ?? null) !== revision) throw new VaultConflict();
    const serialized = JSON.stringify(clean);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
    return { revision: createHash('sha256').update(serialized).digest('hex'), envelope: clean };
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(target + '.lock');
  }
}
