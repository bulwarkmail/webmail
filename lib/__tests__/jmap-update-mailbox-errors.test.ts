import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

// A single-folder update is shared by rename, role assignment, reordering
// and moving a folder. Exercise its real HTTP-200 protocol path for each.
const changes = [
  { name: 'Renamed' }, { role: 'archive' }, { sortOrder: 2 }, { parentId: 'parent' },
];

function client() {
  const c = new JMAPClient('https://mail.example.test', 'a@example.test', 'fake');
  Object.assign(c, { apiUrl: 'https://mail.example.test/jmap', accountId: 'own' });
  return c;
}
function answer(method: string, result: Record<string, unknown>) {
  return new Response(JSON.stringify({ sessionState: 'session-1', methodResponses: [[method, result, '0']] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
afterEach(() => vi.restoreAllMocks());

describe('updateMailbox confirms protocol success', () => {
  it.each(changes)('rejects a method refusal for %j and retains its JMAP type', async (patch) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('error', { type: 'forbidden', description: 'Not allowed' }));
    await expect(client().updateMailbox('folder', patch, 'shared')).rejects.toMatchObject({ message: expect.stringContaining('Not allowed'), jmapType: 'forbidden' });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).methodCalls).toEqual([
      ['Mailbox/set', { accountId: 'shared', update: { folder: patch } }, '0'],
    ]);
  });
  it('uses the error type when no description is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('error', { type: 'serverFail' }));
    await expect(client().updateMailbox('folder', { name: 'New' })).rejects.toThrow('serverFail');
  });
  it('retains per-record refusal behavior', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('Mailbox/set', { notUpdated: { folder: { type: 'invalidProperties' } } }));
    await expect(client().updateMailbox('folder', { name: 'New' })).rejects.toThrow('Failed to update mailbox: invalidProperties');
  });
  it.each(changes)('preserves successful update behavior for %j', async (patch) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('Mailbox/set', { accountId: 'own', oldState: 's0', newState: 's1', updated: { folder: null } }));
    await expect(client().updateMailbox('folder', patch)).resolves.toBeUndefined();
  });
  it('propagates transport rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(client().updateMailbox('folder', { name: 'New' })).rejects.toThrow('Failed to fetch');
  });
});
