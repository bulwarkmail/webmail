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

  it('keeps the source when the copy fails', async () => {
    const { client, calls } = clientWithCopyResult({ notCreated: { c: { type: 'overQuota' } } });
    await expect(client.copyEmailAcrossAccounts('m1', 'me', 'grp', 'inbox')).rejects.toThrow('overQuota');
    expect(calls.some(([m]) => m === 'Email/set')).toBe(false);
  });
});
