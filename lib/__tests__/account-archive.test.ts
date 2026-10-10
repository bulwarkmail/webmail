// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  archiveIdentity, decryptArchive, encryptArchive, parseArchiveEnvelope, parseArchivedAccounts, type ArchivedAccount,
} from '@/lib/account-archive';

const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const accounts: ArchivedAccount[] = [
  { username: 'owner@example.com', serverUrl: 'https://mail.example.com', label: 'Work', avatarColor: '#2563eb' },
  { username: 'me@other.example', serverUrl: 'https://jmap.other.example/', label: 'Home', avatarColor: '#16a34a' },
];
const password = 'correct horse battery';

describe('account archive encryption', () => {
  it('round-trips the account list and leaves only ciphertext in the envelope', async () => {
    const envelope = await encryptArchive(owner, accounts, password);
    expect(JSON.stringify(envelope)).not.toContain('example');
    expect(JSON.stringify(envelope)).not.toContain('Work');
    expect(await decryptArchive(owner, envelope, password)).toEqual([
      accounts[0], { ...accounts[1], serverUrl: 'https://jmap.other.example' },
    ]);
  });

  it('refuses a wrong password and an envelope moved to another owner', async () => {
    const envelope = await encryptArchive(owner, accounts, password);
    await expect(decryptArchive(owner, envelope, 'wrong password!')).rejects.toThrow('unlock_failed');
    await expect(decryptArchive({ ...owner, username: 'thief@example.com' }, envelope, password)).rejects.toThrow('unlock_failed');
  });

  it('treats the owner username without regard to case', async () => {
    const envelope = await encryptArchive({ ...owner, username: 'Owner@Example.com' }, accounts, password);
    expect(await decryptArchive(owner, envelope, password)).toHaveLength(2);
    expect(archiveIdentity({ ...owner, username: 'OWNER@example.com' })).toBe(archiveIdentity(owner));
    expect(archiveIdentity({ ...owner, serverUrl: 'https://mail.example.com/' })).toBe(archiveIdentity(owner));
  });

  it('demands a password of at least 10 characters', async () => {
    await expect(encryptArchive(owner, accounts, 'short')).rejects.toThrow('password_length');
  });

  it('never carries a password or any other extra field', async () => {
    const withSecrets = accounts.map(a => ({ ...a, password: 'mailbox-secret', token: 't' }));
    const envelope = await encryptArchive(owner, withSecrets, password);
    const restored = await decryptArchive(owner, envelope, password);
    expect(JSON.stringify(restored)).not.toContain('mailbox-secret');
    expect(Object.keys(restored[0]).sort()).toEqual(['avatarColor', 'label', 'serverUrl', 'username']);
  });

  it('rejects malformed lists and envelopes', async () => {
    expect(() => parseArchivedAccounts([])).toThrow('invalid_archive');
    expect(() => parseArchivedAccounts([{ ...accounts[0], avatarColor: 'red' }])).toThrow('invalid_archive');
    const envelope = await encryptArchive(owner, accounts, password);
    expect(parseArchiveEnvelope({ ...envelope, extra: 'x' })).toEqual(envelope);
    expect(() => parseArchiveEnvelope({ ...envelope, iterations: 1000 })).toThrow('invalid_archive');
    expect(() => parseArchiveEnvelope({ ...envelope, iv: 'AAAA' })).toThrow('invalid_archive');
  });
});
