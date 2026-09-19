import { describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '../jmap/client-interface';
import { collectTransferMessages, transferMessages } from '../email-transfer';

function client(id: string) {
  return {
    getAccountId: () => id, getServerUrl: () => `https://${id}.example`, getMaxSizeUpload: () => 100000, getMaxObjectsInGet: () => 256,
    getMailboxes: vi.fn().mockResolvedValue([{ id: 'inbox', myRights: { mayAddItems: true } }]),
    getEmail: vi.fn().mockResolvedValue({ id: 'e1', blobId: 'raw', size: 100, receivedAt: '2020-02-01T00:00:00Z', keywords: { $flagged: true } }),
    getEmails: vi.fn(),
    fetchBlob: vi.fn().mockResolvedValue(new Blob(['MIME bytes'], { type: 'message/rfc822' })),
    uploadBlob: vi.fn().mockResolvedValue({ blobId: 'uploaded' }),
    importEmail: vi.fn().mockResolvedValue('imported'),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  };
}
function setup(mode: 'copy' | 'move' = 'move') {
  const source = client('source');
  const target = client('target');
  const messages = ['e1', 'e2'].map(id => ({ id, client: source as unknown as IJMAPClient, accountId: 'owner', localAccountId: 'login' }));
  return { source, target, args: { messages, destination: target as unknown as IJMAPClient, mailboxId: 'inbox', mode } };
}

describe('cross-account transfer', () => {
  it('preserves the MIME blob, keywords and received date, then deletes with the source owner', async () => {
    const { source, target, args } = setup();
    const result = await transferMessages(args);
    expect(target.importEmail).toHaveBeenCalledWith('uploaded', { inbox: true }, { $flagged: true }, 'target', '2020-02-01T00:00:00Z');
    expect(source.fetchBlob).toHaveBeenCalledWith('raw', 'message.eml', 'message/rfc822', 'owner');
    const upload = target.uploadBlob.mock.calls[0][0] as File;
    expect(upload.type).toBe('message/rfc822');
    expect(upload.size).toBe(new Blob(['MIME bytes']).size);
    expect(source.deleteEmail).toHaveBeenNthCalledWith(1, 'e1', 'owner');
    expect(target.importEmail.mock.invocationCallOrder[0]).toBeLessThan(source.deleteEmail.mock.invocationCallOrder[0]);
    expect(result).toEqual({ total: 2, completed: 2, copied: 2, moved: 2 });
  });
  it('copies without deleting originals', async () => {
    const { source, args } = setup('copy');
    expect(await transferMessages(args)).toMatchObject({ copied: 2, moved: 0 });
    expect(source.deleteEmail).not.toHaveBeenCalled();
  });
  it.each(['download', 'upload', 'import', 'unconfirmed'])('keeps the original after a %s failure and stops the batch', async stage => {
    const { source, target, args } = setup();
    if (stage === 'download') source.fetchBlob.mockRejectedValue(new Error('failed'));
    if (stage === 'upload') target.uploadBlob.mockRejectedValue(new Error('failed'));
    if (stage === 'import') target.importEmail.mockRejectedValue(new Error('quota'));
    if (stage === 'unconfirmed') target.importEmail.mockResolvedValue(null);
    const result = await transferMessages(args);
    expect(result.failure).toMatchObject({ emailId: 'e1', copied: false });
    expect(source.deleteEmail).not.toHaveBeenCalled();
    expect(source.getEmail).toHaveBeenCalledTimes(1);
  });
  it('reports a copy left on both servers when source deletion fails', async () => {
    const { source, args } = setup();
    source.deleteEmail.mockRejectedValue(new Error('forbidden'));
    expect(await transferMessages(args)).toMatchObject({ copied: 1, moved: 0, failure: { copied: true, message: 'forbidden' } });
  });
  it('cancels between messages, finishing an already imported move safely', async () => {
    const { source, target, args } = setup();
    const controller = new AbortController();
    target.importEmail.mockImplementation(async () => { controller.abort(); return 'imported'; });
    expect(await transferMessages({ ...args, signal: controller.signal })).toMatchObject({ completed: 1, copied: 1, moved: 1 });
    expect(source.deleteEmail).toHaveBeenCalledTimes(1);
  });
  it('cancels during download without uploading or deleting', async () => {
    const { source, target, args } = setup();
    const controller = new AbortController();
    source.fetchBlob.mockImplementation(async () => { controller.abort(); return new Blob(['raw']); });
    expect(await transferMessages({ ...args, signal: controller.signal })).toMatchObject({ completed: 0 });
    expect(target.uploadBlob).not.toHaveBeenCalled();
    expect(source.deleteEmail).not.toHaveBeenCalled();
  });
  it('rejects same-account transfers before copying anything', async () => {
    const { source, args } = setup();
    await expect(transferMessages({ ...args, destination: source as unknown as IJMAPClient })).rejects.toThrow('different');
    expect(source.getEmail).not.toHaveBeenCalled();
  });
  it('rejects read-only destinations before touching source messages', async () => {
    const { source, target, args } = setup();
    target.getMailboxes.mockResolvedValue([{ id: 'inbox', myRights: { mayAddItems: false } }]);
    await expect(transferMessages(args)).rejects.toThrow('writable');
    expect(source.getEmail).not.toHaveBeenCalled();
  });
  it('enumerates every page before returning a bulk snapshot', async () => {
    const source = client('source');
    source.getEmails.mockResolvedValueOnce({ emails: [{ id: 'a' }, { id: 'b' }], hasMore: true, total: 3, state: 's1' })
      .mockResolvedValueOnce({ emails: [{ id: 'c' }], hasMore: false, total: 3, state: 's1' });
    const result = await collectTransferMessages(source as unknown as IJMAPClient, 'login', 'folder');
    expect(result.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(source.getEmails).toHaveBeenNthCalledWith(2, 'folder', 'source', 200, 2);
    expect(source.deleteEmail).not.toHaveBeenCalled();
  });
  it('refuses an unstable bulk snapshot instead of silently skipping messages', async () => {
    const source = client('source');
    source.getEmails.mockResolvedValueOnce({ emails: [{ id: 'a' }], hasMore: true, total: 2, state: 's1' })
      .mockResolvedValueOnce({ emails: [{ id: 'c' }], hasMore: false, total: 2, state: 's2' });
    await expect(collectTransferMessages(source as unknown as IJMAPClient, 'login')).rejects.toThrow('changed');
  });
});
