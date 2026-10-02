// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decryptVault, encryptVault, parseVaultContents, parseVaultEnvelope, parseVaultName, type VaultContents, type VaultEnvelope } from '../account-vault';
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
/** An archive as it was sealed when the username's case still told owners apart. */
async function sealWithIdentity(value: VaultContents, pass: string, identity: string): Promise<VaultEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`bulwark-account-vault:1:${identity}`) },
    key, new TextEncoder().encode(JSON.stringify(value)));
  const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64');
  return { version: 1, iterations: 600000, salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext) };
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

  it('hands an archive saved under a differently-cased username to the same owner', async () => {
    const root = await useTemporaryDirectory();
    const { createHash } = await import('node:crypto');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const typed = { username: 'Owner@Example.com', serverUrl: owner.serverUrl };
    const archived: VaultContents = { ...contents, owner: typed,
      accounts: [{ ...typed, password: 'mail-secret', label: 'Personal', avatarColor: '#112233' }] };
    const sealedAs = JSON.stringify([typed.username, typed.serverUrl]);
    const legacyDir = path.join(root, 'account-vaults', createHash('sha256').update(sealedAs).digest('hex'));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, 'b'.repeat(32) + '.json'),
      JSON.stringify({ name: 'Laptop', envelope: await sealWithIdentity(archived, password, sealedAs) }));

    // The session that saved it still finds it, now under the folded identity.
    const [found] = await listVaults(typed);
    expect(found?.name).toBe('Laptop');
    expect(await decryptVault(found!.envelope, password, typed, found!.sealedAs)).toEqual(archived);
    expect(await readdir(path.join(root, 'account-vaults')))
      .toEqual([createHash('sha256').update(JSON.stringify([owner.username, owner.serverUrl])).digest('hex')]);

    // And so does a session that types the username in another case.
    const [shared] = await listVaults(owner);
    expect(shared).toEqual(found);
    expect(await decryptVault(shared!.envelope, password, owner, shared!.sealedAs)).toEqual({ ...archived, owner });
    await expect(decryptVault(shared!.envelope, password, owner)).rejects.toThrow('unlock_failed');

    // Saving over it re-seals it under the folded identity, hint and all.
    const resaved = await saveVault(owner, shared!.id, 'Laptop', await encryptVault({ ...archived, owner }, password), shared!.revision);
    expect(resaved.sealedAs).toBeUndefined();
    expect(await decryptVault(resaved.envelope, password, typed)).toEqual({ ...archived, owner: typed });
  });

  it('caps the number of archives per owner', async () => {
    await useTemporaryDirectory();
    const envelope = await encryptVault(contents, password);
    for (let i = 0; i < 10; i++) await saveVault(owner, null, `Archive ${i}`, envelope, null);
    await expect(saveVault(owner, null, 'One too many', envelope, null)).rejects.toBeInstanceOf(VaultLimit);
    expect(await listVaults({ ...owner, username: 'other@example.com' })).toEqual([]);
  });
});
