// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decryptVault, encryptVault, parseVaultContents, parseVaultEnvelope, type VaultContents } from '../account-vault';
import { loadVault, saveVault, VaultConflict } from '../account-vault-storage';

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

  it('stores ciphertext only and rejects stale or concurrent replacements without corrupting the archive', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'bulwark-vault-'));
    process.env.SETTINGS_DATA_DIR = directory;
    const envelope = await encryptVault(contents, password);
    expect(await loadVault(owner)).toBeNull();
    const first = await saveVault(owner, { ...envelope, password: 'MUST-NOT-PERSIST' } as typeof envelope, null);
    const [file] = await readdir(path.join(directory, 'account-vaults'));
    const raw = await readFile(path.join(directory, 'account-vaults', file), 'utf8');
    for (const secret of ['MUST-NOT-PERSIST', password, 'mail-secret', owner.username]) expect(raw).not.toContain(secret);
    expect(await loadVault({ ...owner, serverUrl: owner.serverUrl + '/' })).toEqual(first);
    await expect(saveVault(owner, envelope, null)).rejects.toBeInstanceOf(VaultConflict);
    const updated = await encryptVault({ ...contents, accounts: [{ ...contents.accounts[0], label: 'Changed' }] }, password);
    const writes = await Promise.allSettled([saveVault(owner, updated, first.revision), saveVault(owner, updated, first.revision)]);
    expect(writes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(r => r.status === 'rejected')).toHaveLength(1);
    const current = await loadVault(owner);
    expect((await decryptVault(current!.envelope, password, owner)).accounts[0].label).toBe('Changed');
    expect(await readdir(path.join(directory, 'account-vaults'))).toHaveLength(1);
  });
});
