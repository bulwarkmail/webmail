import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type MethodResponse = [string, Record<string, unknown>, string];

function client() {
  const c = new JMAPClient('https://mail.example.test', 'a@example.test', 'fake');
  Object.assign(c, {
    apiUrl: 'https://mail.example.test/jmap', accountId: 'own',
    accounts: { own: { name: 'Personal' }, shared: { name: 'Team' } },
  });
  return c;
}

// Keep the real create/request/HTTP parsing path; only the transport is mocked.
function mockReply(responses: (createId: string) => MethodResponse[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse(init!.body as string);
    const createId = Object.keys(methodCalls[0][1].create)[0];
    return new Response(JSON.stringify({ sessionState: 'session-1', methodResponses: responses(createId) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe('createMailbox preserves refusal diagnostics', () => {
  it('retains a method refusal type and description', async () => {
    mockReply(() => [['error', { type: 'forbidden', description: 'You cannot create folders here' }, '0']]);
    await expect(client().createMailbox('New')).rejects.toMatchObject({
      message: 'Create mailbox failed: You cannot create folders here', jmapType: 'forbidden',
    });
  });

  it('uses the method error type when its description is missing', async () => {
    mockReply(() => [['error', { type: 'serverFail' }, '0']]);
    await expect(client().createMailbox('New')).rejects.toMatchObject({
      message: 'Create mailbox failed: serverFail', jmapType: 'serverFail',
    });
  });

  it('selects the refused call by ID instead of an earlier successful response', async () => {
    mockReply(id => [
      ['Mailbox/set', { created: { [id]: { id: 'unrelated-folder' } } }, 'other-call'],
      ['error', { type: 'forbidden', description: 'Creation refused' }, '0'],
    ]);
    await expect(client().createMailbox('New')).rejects.toMatchObject({
      message: 'Create mailbox failed: Creation refused', jmapType: 'forbidden',
    });
  });

  it('selects the successful call by ID instead of an earlier unrelated error', async () => {
    mockReply(id => [
      ['error', { type: 'forbidden', description: 'Unrelated refusal' }, 'other-call'],
      ['Mailbox/set', { created: { [id]: { id: 'created-folder' } } }, '0'],
    ]);
    await expect(client().createMailbox('New')).resolves.toMatchObject({ id: 'created-folder', name: 'New' });
  });

  it('rejects a missing call response instead of accepting an unrelated created ID', async () => {
    mockReply(id => [['Mailbox/set', { created: { [id]: { id: 'unrelated-folder' } } }, 'other-call']]);
    await expect(client().createMailbox('New')).rejects.toThrow('Create mailbox failed: no response');
  });

  it('keeps per-record error type, properties and description formatting', async () => {
    mockReply(id => [['Mailbox/set', { notCreated: { [id]: {
      type: 'invalidProperties', properties: ['name', 'parentId'], description: 'This parent cannot contain that name',
    } } }, '0']]);
    await expect(client().createMailbox('New', 'parent', 'shared')).rejects.toThrow(
      'Failed to create mailbox: invalidProperties – properties=[name, parentId] – This parent cannot contain that name',
    );
  });

  it('keeps the existing fallback for an untyped per-record refusal', async () => {
    mockReply(id => [['Mailbox/set', { notCreated: { [id]: {} } }, '0']]);
    await expect(client().createMailbox('New')).rejects.toThrow('Failed to create mailbox: unknown error');
  });

  it('creates a subscribed personal root and returns its confirmed metadata', async () => {
    const fetch = mockReply(id => [['Mailbox/set', { created: { [id]: { id: 'created-folder' } } }, '0']]);
    await expect(client().createMailbox('New')).resolves.toMatchObject({
      id: 'created-folder', name: 'New', parentId: undefined, role: undefined,
      isSubscribed: true, accountId: 'own', accountName: 'Personal', isShared: false,
      totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://mail.example.test/jmap');
    const calls = JSON.parse(fetch.mock.calls[0][1]!.body as string).methodCalls;
    expect(calls).toEqual([['Mailbox/set', { accountId: 'own', create: {
      [Object.keys(calls[0][1].create)[0]]: { name: 'New', isSubscribed: true },
    } }, '0']]);
  });

  it('preserves an explicit owner account, parent and optional role', async () => {
    const fetch = mockReply(id => [['Mailbox/set', { created: { [id]: { id: 'shared-child' } } }, '0']]);
    await expect(client().createMailbox('Archive', 'parent', 'shared', { role: 'archive' })).resolves.toMatchObject({
      id: 'shared-child', name: 'Archive', parentId: 'parent', role: 'archive',
      isSubscribed: true, accountId: 'shared', accountName: 'Team', isShared: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const calls = JSON.parse(fetch.mock.calls[0][1]!.body as string).methodCalls;
    expect(calls[0][1].accountId).toBe('shared');
    expect(Object.values(calls[0][1].create)).toEqual([
      { name: 'Archive', isSubscribed: true, parentId: 'parent', role: 'archive' },
    ]);
  });

  it.each([false, true])('keeps the missing-created-ID guard (record present: %s)', async recordPresent => {
    mockReply(id => [['Mailbox/set', recordPresent ? { created: { [id]: {} } } : {}, '0']]);
    await expect(client().createMailbox('New')).rejects.toThrow('Failed to create mailbox: no ID returned');
  });

  it('propagates a transport rejection unchanged without replaying creation', async () => {
    const error = new TypeError('Failed to fetch');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    await expect(client().createMailbox('New')).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
