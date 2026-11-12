import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

function client() {
  const c = new JMAPClient('https://mail.example.test', 'a@example.test', 'synthetic');
  Object.assign(c, { apiUrl: 'https://mail.example.test/jmap', accountId: 'own' });
  return c;
}

// Keep delete/request/HTTP parsing real, as in the creation regression tests.
function mockReply(method: string, result: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    sessionState: 'session-1', methodResponses: [[method, result, '0']],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

afterEach(() => vi.restoreAllMocks());

describe('deleteMailbox refusal handling', () => {
  it('rejects a method refusal with the server description and JMAP type', async () => {
    mockReply('error', { type: 'forbidden', description: 'Deletion refused by policy' });
    await expect(client().deleteMailbox('folder')).rejects.toMatchObject({
      message: 'Delete mailbox failed: Deletion refused by policy', jmapType: 'forbidden',
    });
  });

  it('uses the method error type when its description is absent', async () => {
    mockReply('error', { type: 'serverFail' });
    await expect(client().deleteMailbox('folder')).rejects.toMatchObject({
      message: 'Delete mailbox failed: serverFail', jmapType: 'serverFail',
    });
  });

  it('preserves per-record descriptions, types and properties', async () => {
    mockReply('Mailbox/set', { notDestroyed: { folder: {
      type: 'invalidProperties', description: 'Server record diagnostic', properties: ['id'],
    } } });
    await expect(client().deleteMailbox('folder')).rejects.toMatchObject({
      message: 'Server record diagnostic', jmapType: 'invalidProperties', jmapProperties: ['id'],
    });
  });

  it('preserves the per-record message fallback and type', async () => {
    mockReply('Mailbox/set', { notDestroyed: { folder: { type: 'forbidden' } } });
    await expect(client().deleteMailbox('folder')).rejects.toMatchObject({
      message: 'Failed to delete mailbox: forbidden', jmapType: 'forbidden',
    });
  });

  it('preserves the untyped per-record fallback', async () => {
    mockReply('Mailbox/set', { notDestroyed: { folder: {} } });
    await expect(client().deleteMailbox('folder')).rejects.toThrow('Failed to delete mailbox: unknown error');
  });

  it.each([
    { accountId: undefined, options: undefined, expected: { accountId: 'own', destroy: ['folder'] } },
    { accountId: 'owner', options: undefined, expected: { accountId: 'owner', destroy: ['folder'] } },
    { accountId: 'owner', options: { removeEmails: true }, expected: { accountId: 'owner', destroy: ['folder'], onDestroyRemoveEmails: true } },
    { accountId: undefined, options: { removeEmails: false }, expected: { accountId: 'own', destroy: ['folder'] } },
  ])('preserves confirmed deletion arguments: $expected', async ({ accountId, options, expected }) => {
    // The option control checks serialization only; no real folder or contents.
    const fetch = mockReply('Mailbox/set', { accountId: expected.accountId, oldState: 's0', newState: 's1', destroyed: ['folder'] });
    await expect(client().deleteMailbox('folder', accountId, options)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://mail.example.test/jmap');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).methodCalls).toEqual([
      ['Mailbox/set', expected, '0'],
    ]);
  });

  it('propagates the original transport rejection without replay', async () => {
    const error = new TypeError('Failed to fetch');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    await expect(client().deleteMailbox('folder')).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
