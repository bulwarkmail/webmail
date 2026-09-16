// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decryptVault, encryptVault, parseVaultContents, parseVaultEnvelope, parseVaultName, type VaultContents } from '../account-vault';
import { deleteVault, LEGACY_VAULT_NAME, listVaults, loadVault, saveVault, VaultConflict, VaultLimit } from '../account-vault-storage';

const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const contents: VaultContents = { owner, accounts: [{ ...owner, password: 'mail-secret', label: 'Personal', avatarColor: '#112233' }], defaultAccountId: null };
const password = 'an independent archive passphrase';
let directory: string | undefined;
const originalDir = process.env.SETTINGS_DATA_DIR;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  if (originalDir === undefined) delete process.env.SETTINGS_DATA_DIR;
  else process.env.SETTINGS_DATA_DIR = originalDir;
});
async function useTemporaryDirectory(): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), 'bulwark-vault-'));
  process.env.SETTINGS_DATA_DIR = directory;
  return directory;
}
async function ownerFiles(root: string): Promise<string[]> {
  const [ownerDir] = await readdir(path.join(root, 'account-vaults'));
  return readdir(path.join(root, 'account-vaults', ownerDir));
}

describe('account vault encryption and storage', () => {
  it('round-trips an encrypted account list without mailbox passwords', async () => {
    const metadata = { ...contents, accounts: contents.accounts.map(({ password: _password, ...account }) => account) };
    const envelope = await encryptVault(metadata, password);
    const restored = await decryptVault(envelope, password, owner);
    expect(restored).toEqual(metadata);
    expect(restored.accounts[0]).not.toHaveProperty('password');
    for (const invalid of [null, '', 42]) {
      expect(() => parseVaultContents({ ...metadata, accounts: [{ ...metadata.accounts[0], password: invalid }] }, owner)).toThrow();
    }
  });

  it('round-trips only with the archive password and the correct owner, with randomized ciphertext', async () => {
    const a = await encryptVault(contents, password);
    const b = await encryptVault(contents, password);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptVault(a, password, owner)).toEqual(contents);
    await expect(decryptVault(a, 'wrong password', owner)).rejects.toThrow('unlock_failed');
    await expect(decryptVault(a, password, { ...owner, username: 'other' })).rejects.toThrow('unlock_failed');
    const bytes = Buffer.from(a.ciphertext, 'base64'); bytes[0] ^= 1;
    await expect(decryptVault({ ...a, ciphertext: bytes.toString('base64') }, password, owner)).rejects.toThrow('unlock_failed');
  });

  it('rejects unsafe metadata, duplicate accounts and attacker-controlled KDF work factors', async () => {
    expect(() => parseVaultContents({ ...contents, accounts: [...contents.accounts, ...contents.accounts] }, owner)).toThrow();
    expect(() => parseVaultContents({ ...contents, owner: { ...owner, serverUrl: 'http://mail.example.com' } }, owner)).toThrow();
    const envelope = await encryptVault(contents, password);
    expect(() => parseVaultEnvelope({ ...envelope, iterations: 1 })).toThrow();
    expect(() => parseVaultEnvelope({ ...envelope, iterations: 999999999 })).toThrow();
    await expect(encryptVault(contents, 'short')).rejects.toThrow('password_length');
  });

  it('accepts short printable archive names only', () => {
    expect(parseVaultName('  Laptop  ')).toBe('Laptop');
    for (const invalid of ['', '   ', 'x'.repeat(81), 'two\nlines', 42, null]) expect(() => parseVaultName(invalid)).toThrow('invalid_name');
  });

  it('stores named ciphertext only and rejects stale or concurrent replacements without corrupting the archive', async () => {
    const root = await useTemporaryDirectory();
    const envelope = await encryptVault(contents, password);
    expect(await listVaults(owner)).toEqual([]);
    const first = await saveVault(owner, null, 'Laptop', { ...envelope, password: 'MUST-NOT-PERSIST' } as typeof envelope, null);
    expect(first).toMatchObject({ name: 'Laptop', envelope });
    const [file] = await ownerFiles(root);
    const raw = await readFile(path.join(root, 'account-vaults', (await readdir(path.join(root, 'account-vaults')))[0], file), 'utf8');
    for (const secret of ['MUST-NOT-PERSIST', password, 'mail-secret', owner.username]) expect(raw).not.toContain(secret);
    expect(await listVaults({ ...owner, serverUrl: owner.serverUrl + '/' })).toEqual([first]);

    await expect(saveVault(owner, first.id, 'Laptop', envelope, null)).rejects.toBeInstanceOf(VaultConflict);
    await expect(saveVault(owner, first.id, 'Laptop', envelope, 'f'.repeat(64))).rejects.toBeInstanceOf(VaultConflict);
    const updated = await encryptVault({ ...contents, accounts: [{ ...contents.accounts[0], label: 'Changed' }] }, password);
    const writes = await Promise.allSettled([
      saveVault(owner, first.id, 'Laptop', updated, first.revision), saveVault(owner, first.id, 'Laptop', updated, first.revision),
    ]);
    expect(writes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(r => r.status === 'rejected')).toHaveLength(1);
    const current = await loadVault(owner, first.id);
    expect((await decryptVault(current!.envelope, password, owner)).accounts[0].label).toBe('Changed');
    expect(await ownerFiles(root)).toEqual([file]);
  });

  it('keeps several named archives per owner apart and deletes only the current revision', async () => {
    const root = await useTemporaryDirectory();
    const envelope = await encryptVault(contents, password);
    const phone = await saveVault(owner, null, 'Phone', envelope, null);
    const laptop = await saveVault(owner, null, 'Laptop', envelope, null);
    expect(phone.id).not.toBe(laptop.id);
    expect((await listVaults(owner)).map(v => v.name)).toEqual(['Laptop', 'Phone']);
    const renamed = await saveVault(owner, phone.id, 'Old phone', envelope, phone.revision);
    expect((await listVaults(owner)).map(v => v.name)).toEqual(['Laptop', 'Old phone']);

    await expect(deleteVault(owner, phone.id, phone.revision)).rejects.toBeInstanceOf(VaultConflict);
    await deleteVault(owner, renamed.id, renamed.revision);
    expect(await listVaults(owner)).toEqual([laptop]);
    await expect(deleteVault(owner, renamed.id, renamed.revision)).rejects.toBeInstanceOf(VaultConflict);
    expect(await ownerFiles(root)).toEqual([laptop.id + '.json']);
  });

  it('migrates a single-archive-format file into a named archive, once', async () => {
    const root = await useTemporaryDirectory();
    const envelope = await encryptVault(contents, password);
    const { createHash } = await import('node:crypto');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const hash = createHash('sha256').update(JSON.stringify([owner.username, owner.serverUrl])).digest('hex');
    await mkdir(path.join(root, 'account-vaults'), { recursive: true });
    await writeFile(path.join(root, 'account-vaults', hash + '.json'), JSON.stringify(envelope));
    const [migrated] = await listVaults(owner);
    expect(migrated?.name).toBe(LEGACY_VAULT_NAME);
    expect(await decryptVault(migrated!.envelope, password, owner)).toEqual(contents);
    expect(await readdir(path.join(root, 'account-vaults'))).toEqual([hash]);
    expect(await listVaults(owner)).toEqual([migrated]);
  });

  it('caps the number of archives per owner', async () => {
    await useTemporaryDirectory();
    const envelope = await encryptVault(contents, password);
    for (let i = 0; i < 10; i++) await saveVault(owner, null, `Archive ${i}`, envelope, null);
    await expect(saveVault(owner, null, 'One too many', envelope, null)).rejects.toBeInstanceOf(VaultLimit);
    expect(await listVaults({ ...owner, username: 'other@example.com' })).toEqual([]);
  });
});
