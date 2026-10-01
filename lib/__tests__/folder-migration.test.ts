import { describe, it, expect, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email } from '@/lib/jmap/types';
import {
  FolderChangedError,
  SameAccountError,
  listFolderEmailIds,
  migrateFolder,
} from '../folder-migration';

function email(id: string, mailboxIds: Record<string, boolean> = { src: true }): Email {
  return {
    id, blobId: `blob-${id}`, mailboxIds, keywords: { $seen: true }, receivedAt: `2020-01-0${id.slice(1)}T00:00:00Z`,
  } as unknown as Email;
}

/** A source account whose folder holds `emails`; deletes take them out of it. */
function sourceClient(emails: Email[], opts: { pageSize?: number; url?: string; accountId?: string } = {}) {
  const folder = [...emails];
  const client = {
    getServerUrl: () => opts.url ?? 'https://a.example',
    getAccountId: () => opts.accountId ?? 'acc-a',
    getMaxObjectsInGet: () => opts.pageSize ?? 200,
    getEmails: vi.fn(async (_mb: string, _acc: string | undefined, limit: number, position: number) => {
      const page = folder.slice(position, position + limit);
      return { emails: page, total: folder.length, hasMore: position + page.length < folder.length };
    }),
    getEmail: vi.fn(async (id: string) => emails.find((e) => e.id === id) ?? null),
    fetchBlob: vi.fn(async (blobId: string) => new Blob([blobId])),
    deleteEmail: vi.fn(async (id: string) => {
      const i = folder.findIndex((e) => e.id === id);
      if (i >= 0) folder.splice(i, 1);
    }),
  };
  return { client, folder, asClient: client as unknown as IJMAPClient };
}

function destClient(opts: { url?: string; accountId?: string } = {}) {
  const client = {
    getServerUrl: () => opts.url ?? 'https://b.example',
    getAccountId: () => opts.accountId ?? 'acc-b',
    importRawEmail: vi.fn(async () => 'new-id'),
  };
  return { client, asClient: client as unknown as IJMAPClient };
}

describe('listFolderEmailIds', () => {
  it('reads every page before anything changes', async () => {
    const src = sourceClient(['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => email(id)), { pageSize: 2 });
    await expect(listFolderEmailIds(src.asClient, 'src')).resolves.toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(src.client.getEmails).toHaveBeenCalledTimes(3);
    expect(src.client.getEmails.mock.calls.map((c) => c[3])).toEqual([0, 2, 4]);
  });

  it('fails when the folder changes while it is read', async () => {
    const src = sourceClient([email('e1'), email('e2'), email('e3')], { pageSize: 2 });
    src.client.getEmails.mockImplementationOnce(async () => ({ emails: [email('e1'), email('e2')], total: 4, hasMore: true }));
    await expect(listFolderEmailIds(src.asClient, 'src')).rejects.toBeInstanceOf(FolderChangedError);
  });
});

describe('migrateFolder', () => {
  it('copies every message with its flags and date and keeps the originals', async () => {
    const src = sourceClient([email('e1'), email('e2'), email('e3')], { pageSize: 2 });
    const dst = destClient();
    const progress = vi.fn();

    const result = await migrateFolder({
      source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'copy', onProgress: progress,
    });

    expect(result).toEqual({ total: 3, done: 3, kept: 0, stopped: false });
    expect(dst.client.importRawEmail).toHaveBeenCalledTimes(3);
    expect(dst.client.importRawEmail).toHaveBeenCalledWith(expect.any(Blob), { dst: true }, { $seen: true }, undefined, '2020-01-01T00:00:00Z');
    expect(src.client.deleteEmail).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith({ total: 3, done: 3, kept: 0 });
  });

  it('moves every message even though deleting shrinks the folder', async () => {
    const src = sourceClient(['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => email(id)), { pageSize: 2 });
    const dst = destClient();

    const result = await migrateFolder({
      source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'move',
    });

    expect(result.done).toBe(5);
    expect(src.client.deleteEmail.mock.calls.map((c) => c[0])).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(src.folder).toEqual([]);
  });

  it('destroys a moved message only after its import', async () => {
    const src = sourceClient([email('e1')]);
    const dst = destClient();
    const order: string[] = [];
    dst.client.importRawEmail.mockImplementation(async () => { order.push('import'); return 'n'; });
    src.client.deleteEmail.mockImplementation(async () => { order.push('delete'); });
    await migrateFolder({ source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'move' });
    expect(order).toEqual(['import', 'delete']);
  });

  it('keeps a moved message that is also filed in another folder', async () => {
    const src = sourceClient([email('e1', { src: true, other: true }), email('e2')]);
    const dst = destClient();
    const result = await migrateFolder({ source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'move' });
    expect(result).toMatchObject({ done: 2, kept: 1 });
    expect(src.client.deleteEmail.mock.calls.map((c) => c[0])).toEqual(['e2']);
  });

  it('stops at the first failed import without retrying or deleting', async () => {
    const src = sourceClient([email('e1'), email('e2'), email('e3')]);
    const dst = destClient();
    dst.client.importRawEmail
      .mockResolvedValueOnce('n1')
      .mockRejectedValueOnce(new Error('overQuota'));

    const result = await migrateFolder({ source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'move' });

    expect(result).toEqual({
      total: 3, done: 1, kept: 0, stopped: true,
      failure: { emailId: 'e2', imported: false, message: 'overQuota' },
    });
    expect(dst.client.importRawEmail).toHaveBeenCalledTimes(2);
    expect(src.client.deleteEmail.mock.calls.map((c) => c[0])).toEqual(['e1']);
  });

  it('reports a message that was imported but could not be removed', async () => {
    const src = sourceClient([email('e1'), email('e2')]);
    const dst = destClient();
    src.client.deleteEmail.mockRejectedValueOnce(new Error('forbidden'));
    const result = await migrateFolder({ source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'move' });
    expect(result.failure).toEqual({ emailId: 'e1', imported: true, message: 'forbidden' });
    expect(dst.client.importRawEmail).toHaveBeenCalledTimes(1);
  });

  it('stops when aborted and leaves the rest untouched', async () => {
    const src = sourceClient([email('e1'), email('e2'), email('e3')]);
    const dst = destClient();
    const controller = new AbortController();
    dst.client.importRawEmail.mockImplementation(async () => { controller.abort(); return 'n'; });

    const result = await migrateFolder({
      source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'move', signal: controller.signal,
    });

    // The message in flight is finished (imported and destroyed), nothing after it.
    expect(result).toEqual({ total: 3, done: 1, kept: 0, stopped: true });
    expect(src.client.deleteEmail).toHaveBeenCalledTimes(1);
    expect(src.client.getEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a destination in the same account', async () => {
    const src = sourceClient([email('e1')]);
    const dst = destClient({ url: 'https://a.example', accountId: 'acc-a' });
    await expect(migrateFolder({ source: src.asClient, sourceMailboxId: 'src', destination: dst.asClient, destMailboxId: 'dst', mode: 'copy' }))
      .rejects.toBeInstanceOf(SameAccountError);
    expect(src.client.getEmails).not.toHaveBeenCalled();
  });
});
