import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import type { Mailbox } from '@/lib/jmap/types';
import { useEmailStore } from '../email-store';

const initialState = useEmailStore.getState();
type MethodCall = [string, Record<string, unknown>, string];
type RequestTarget = { request(calls: MethodCall[]): Promise<unknown> };

beforeEach(() => useEmailStore.setState(initialState, true));
afterEach(() => {
  vi.restoreAllMocks();
  useEmailStore.setState(initialState, true);
});

describe('failed mailbox pagination during a store refresh', () => {
  it('preserves the entire folder list, collection states, and selection when another account succeeds', async () => {
    const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
    Object.assign(client, {
      apiUrl: 'https://jmap.example.com/api',
      accountId: 'primary',
      accounts: { primary: { name: 'Self' }, shared: { name: 'Shared' } },
      capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 } },
    });
    const previousMailboxes = [
      { id: 'inbox', name: 'Inbox', role: 'inbox', accountId: 'primary', isShared: false },
      { id: 'child', name: 'Selected folder', parentId: 'inbox', accountId: 'primary', isShared: false },
      { id: 'shared:inbox', originalId: 'inbox', name: 'Shared Inbox', accountId: 'shared', isShared: true },
    ] as Mailbox[];
    const previousStates = { primary: 'old-primary', shared: 'old-shared' };
    useEmailStore.setState({
      mailboxes: previousMailboxes,
      mailboxSyncStates: previousStates,
      selectedMailbox: 'child',
      isLoading: false,
      error: null,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = vi.spyOn(client as unknown as RequestTarget, 'request')
      .mockResolvedValueOnce({ methodResponses: [
        ['Mailbox/get', { list: [{ id: 'inbox' }, { id: 'child' }], state: 'new-primary' }, '0'],
        ['Mailbox/get', { list: [{ id: 'inbox', name: 'Shared Inbox', role: 'inbox' }], state: 'new-shared' }, '1'],
      ] })
      .mockResolvedValueOnce({ methodResponses: [
        ['Mailbox/query', { ids: ['inbox', 'child'], queryState: 'q', total: 3 }, 'query'],
        ['Mailbox/get', { list: [{ id: 'inbox', name: 'Inbox' }, { id: 'child', name: 'Selected folder' }], state: 'new-primary', notFound: [] }, 'get'],
      ] })
      .mockRejectedValueOnce(new Error('Later mailbox page failed'));

    await useEmailStore.getState().fetchMailboxes(client);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][0][0][1].position).toBe(2);
    const state = useEmailStore.getState();
    expect(state.mailboxes).toBe(previousMailboxes);
    expect(state.mailboxSyncStates).toBe(previousStates);
    expect(state.selectedMailbox).toBe('child');
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeTruthy();
  });
});
