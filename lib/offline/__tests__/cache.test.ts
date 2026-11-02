import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheUsage,
  emailIndex,
  emailKey,
  enforceCap,
  forgetIndexes,
  getBlob,
  getBody,
  getMisc,
  patchEmails,
  putBlob,
  putEmails,
  putMisc,
  wipeAccountCache,
} from '../cache';
import { forgetDeviceKey, openJson, sealJson } from '../crypto';
import { allowOfflineDbCreation, deleteOfflineDb, idbGet, idbGetAll } from '../db';

const day = 24 * 60 * 60 * 1000;
const email = (id: string, ageDays: number, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `t-${id}`,
  mailboxIds: { inbox: true },
  keywords: {},
  receivedAt: new Date(Date.now() - ageDays * day).toISOString(),
  subject: `Subject ${id}`,
  ...extra,
});

beforeEach(async () => {
  forgetIndexes();
  forgetDeviceKey();
  await deleteOfflineDb();
  allowOfflineDbCreation();
});

describe('offline encryption', () => {
  it('keeps nothing readable and a key that cannot be exported', async () => {
    const sealed = await sealJson({ subject: 'Quarterly numbers' });
    expect(new TextDecoder().decode(sealed.data)).not.toContain('Quarterly');
    expect(await openJson(sealed)).toEqual({ subject: 'Quarterly numbers' });
    const stored = await idbGet<{ key: CryptoKey }>('keys', 'aes');
    expect(stored?.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', stored!.key)).rejects.toThrow();
  });

  it('stores messages encrypted, list part and body apart', async () => {
    await putEmails('acc', 'j1', [email('m1', 1, { bodyValues: { 1: { value: 'Secret text' } }, textBody: [{ partId: '1' }] })]);
    const records = await idbGetAll<{ data: ArrayBuffer }>('emails');
    expect(records).toHaveLength(1);
    expect(new TextDecoder().decode(records[0].data)).not.toContain('Subject m1');
    const bodies = await idbGetAll<{ data: ArrayBuffer }>('bodies');
    expect(new TextDecoder().decode(bodies[0].data)).not.toContain('Secret text');

    forgetIndexes();
    const index = await emailIndex('acc');
    const meta = index.get(emailKey('acc', 'j1', 'm1'))!;
    expect(meta.subject).toBe('Subject m1');
    expect(meta).not.toHaveProperty('bodyValues');
    expect((await getBody('acc', 'j1', 'm1'))?.bodyValues).toEqual({ 1: { value: 'Secret text' } });
  });

  it('merges a later list fetch into the kept message', async () => {
    await putEmails('acc', 'j1', [email('m1', 1, { bodyValues: { 1: { value: 'x' } } })]);
    await putEmails('acc', 'j1', [{ id: 'm1', keywords: { $seen: true } }]);
    const meta = (await emailIndex('acc')).get(emailKey('acc', 'j1', 'm1'))!;
    expect(meta.keywords).toEqual({ $seen: true });
    expect(meta.subject).toBe('Subject m1');
    expect(await getBody('acc', 'j1', 'm1')).not.toBeNull();
  });

  it('applies keyword and folder patches', async () => {
    await putEmails('acc', 'j1', [email('m1', 1)]);
    await patchEmails('acc', 'j1', { m1: { 'keywords/$flagged': true, 'mailboxIds/inbox': null, 'mailboxIds/archive': true } });
    const meta = (await emailIndex('acc')).get(emailKey('acc', 'j1', 'm1'))!;
    expect(meta.keywords).toEqual({ $flagged: true });
    expect(meta.mailboxIds).toEqual({ archive: true });
  });
});

describe('the cache cap', () => {
  it('drops the oldest messages first, with their bodies and attachments', async () => {
    await putEmails('acc', 'j1', [
      email('old', 20, { bodyValues: { 1: { value: 'a'.repeat(4000) } } }),
      email('mid', 10, { bodyValues: { 1: { value: 'b'.repeat(4000) } } }),
      email('new', 1, { bodyValues: { 1: { value: 'c'.repeat(4000) } } }),
    ]);
    await putBlob('acc', 'j1', 'blob-old', new Blob(['x'.repeat(4000)]), Date.now() - 20 * day, emailKey('acc', 'j1', 'old'));
    const { total } = await cacheUsage();
    // Room for about two messages.
    const freed = await enforceCap(total - 6000);
    expect(freed).toBeGreaterThan(0);
    const index = await emailIndex('acc');
    expect(index.has(emailKey('acc', 'j1', 'old'))).toBe(false);
    expect(index.has(emailKey('acc', 'j1', 'new'))).toBe(true);
    expect(await getBody('acc', 'j1', 'old')).toBeNull();
    expect(await getBlob('acc', 'j1', 'blob-old')).toBeNull();
    expect(await getBody('acc', 'j1', 'new')).not.toBeNull();
    expect((await cacheUsage()).total).toBeLessThanOrEqual(total - 6000);
  });

  it('leaves the cache alone under the cap', async () => {
    await putEmails('acc', 'j1', [email('m1', 1)]);
    expect(await enforceCap()).toBe(0);
  });
});

describe('wiping one account', () => {
  it('removes that account only', async () => {
    await putEmails('a', 'j1', [email('m1', 1)]);
    await putEmails('b', 'j1', [email('m2', 1)]);
    await putMisc('a', 'session', { apiUrl: 'x' });
    await wipeAccountCache('a');
    expect((await emailIndex('a')).size).toBe(0);
    expect(await getMisc('a', 'session')).toBeNull();
    forgetIndexes();
    expect((await emailIndex('b')).size).toBe(1);
  });
});
