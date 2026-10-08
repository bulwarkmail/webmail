import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

function clientWithCopyResult(copyResult: Record<string, unknown>) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'me' });
  const calls: Call[] = [];
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (reqCalls: Call[]) => {
      const [method, args, id] = reqCalls[0];
      calls.push(reqCalls[0]);
      if (method === 'Email/get') return { methodResponses: [['Email/get', { list: [{ id: 'm1', keywords: { $seen: true } }] }, id]] };
      if (method === 'Email/copy') return { methodResponses: [['Email/copy', copyResult, id]] };
      if (method === 'Email/set') return { methodResponses: [['Email/set', { destroyed: args.destroy }, id]] };
      throw new Error(`unexpected ${method}`);
    });
  return { client, calls };
}

describe('copyEmailAcrossAccounts', () => {
  it('destroys the source only after the copy was created', async () => {
    const { client, calls } = clientWithCopyResult({ created: { c: { id: 'new1' } } });
    await expect(client.copyEmailAcrossAccounts('m1', 'me', 'grp', 'inbox')).resolves.toBe('new1');

    const copy = calls.find(([m]) => m === 'Email/copy')![1];
    expect(copy).not.toHaveProperty('onSuccessDestroyOriginal');
    expect(calls.find(([m]) => m === 'Email/set')![1]).toEqual({ accountId: 'me', destroy: ['m1'] });
  });

  it('keeps the source when asked for a plain copy', async () => {
    const { client, calls } = clientWithCopyResult({ created: { c: { id: 'new1' } } });
    await expect(client.copyEmailAcrossAccounts('m1', 'me', 'grp', 'inbox', { keepOriginal: true })).resolves.toBe('new1');
    expect(calls.some(([m]) => m === 'Email/copy')).toBe(true);
    expect(calls.some(([m]) => m === 'Email/set')).toBe(false);
  });

  it('keeps the source when the copy fails', async () => {
    const { client, calls } = clientWithCopyResult({ notCreated: { c: { type: 'overQuota' } } });
    await expect(client.copyEmailAcrossAccounts('m1', 'me', 'grp', 'inbox')).rejects.toThrow('overQuota');
    expect(calls.some(([m]) => m === 'Email/set')).toBe(false);
  });
});

describe('importRawEmail', () => {
  it('keeps the original date of a message carried over from another account', async () => {
    const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
    Object.assign(client, { accountId: 'me' });
    vi.spyOn(client, 'uploadBlob').mockResolvedValue({ blobId: 'b1' } as never);
    const request = vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
      .mockResolvedValue({ methodResponses: [['Email/import', { created: { 'smime-import': { id: 'n1' } } }, '0']] });

    await client.importRawEmail(new Blob(['raw']), { inbox: true }, { $seen: true }, undefined, '2024-03-01T10:00:00Z');
    const emails = (request.mock.calls[0][0][0][1] as { emails: Record<string, Record<string, unknown>> }).emails;
    expect(emails['smime-import'].receivedAt).toBe('2024-03-01T10:00:00Z');

    // Without a date the server stamps the import time, as before.
    await client.importRawEmail(new Blob(['raw']), { inbox: true });
    const plain = (request.mock.calls[1][0][0][1] as { emails: Record<string, Record<string, unknown>> }).emails;
    expect(plain['smime-import']).not.toHaveProperty('receivedAt');
  });
});
