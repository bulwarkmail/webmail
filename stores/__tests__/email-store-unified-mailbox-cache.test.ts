import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUnifiedAccountClients, invalidateUnifiedMailboxes, loadAccountMailboxes, useEmailStore } from '../email-store';
import { useAccountStore } from '../account-store';
import { useAuthStore } from '../auth-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

/**
 * The unified scope is rebuilt on every connection while a browser restores
 * its logins, on every background push and on every unified browse, load-more
 * and search. Each build used to ask every login for its folders again, one
 * login after the other. These tests pin the replacement: one fetch per login,
 * shared and reused until that login reports a change, all logins at once.
 */
const inbox = (id: string, unread: number): Mailbox =>
  ({ id, name: 'Inbox', role: 'inbox', unreadEmails: unread, totalEmails: unread, parentId: null }) as unknown as Mailbox;

function fakeClient(name: string, unread = 1) {
  let release: (() => void) | null = null;
  const client = {
    name,
    gate: null as Promise<void> | null,
    getMailboxes: vi.fn(async () => {
      if (client.gate) await client.gate;
      return [inbox(`${name}-inbox`, unread)];
    }),
    getAllMailboxes: vi.fn(async () => [inbox(`${name}-inbox`, unread)]),
    getAccountId: () => `jmap-${name}`,
    hold() { client.gate = new Promise<void>((r) => { release = r; }); },
    release() { release?.(); client.gate = null; },
  };
  return client;
}

function connect(clients: Record<string, ReturnType<typeof fakeClient>>) {
  useAccountStore.setState({
    accounts: Object.keys(clients).map((id) => ({
      id, label: id, email: id, username: id, serverUrl: 'https://mail.example.org', displayName: id,
      cookieSlot: 0, avatarColor: '#123456', rememberMe: true, isConnected: true, hasError: false,
      isDefault: false, lastLoginAt: 0, authMode: 'basic',
    })) as never,
  });
  const map = new Map(Object.entries(clients).map(([id, c]) => [id, c as unknown as IJMAPClient]));
  useAuthStore.setState({ getAllConnectedClients: () => map } as never);
}

describe('unified scope folder lists', () => {
  beforeEach(() => {
    invalidateUnifiedMailboxes();
    useEmailStore.setState({ accountMailboxes: {} });
  });

  it('fetches each login once across repeated builds', async () => {
    const a = fakeClient('a');
    const b = fakeClient('b');
    connect({ a, b });
    await buildUnifiedAccountClients();
    await buildUnifiedAccountClients();
    await buildUnifiedAccountClients();
    expect(a.getMailboxes).toHaveBeenCalledTimes(1);
    expect(b.getMailboxes).toHaveBeenCalledTimes(1);
  });

  it('shares a fetch in flight between concurrent builds', async () => {
    const a = fakeClient('a');
    a.hold();
    connect({ a });
    const both = Promise.all([buildUnifiedAccountClients(), buildUnifiedAccountClients()]);
    a.release();
    const [first, second] = await both;
    expect(a.getMailboxes).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('asks every login at once, not one after the other', async () => {
    const a = fakeClient('a');
    const b = fakeClient('b');
    a.hold();
    connect({ a, b });
    const build = buildUnifiedAccountClients();
    await Promise.resolve();
    await Promise.resolve();
    // b was asked while a is still pending.
    expect(b.getMailboxes).toHaveBeenCalledTimes(1);
    a.release();
    expect((await build).map((x) => x.accountId)).toEqual(['a', 'b']);
  });

  it('fetches again only the login that reported a change', async () => {
    const a = fakeClient('a');
    const b = fakeClient('b');
    connect({ a, b });
    await buildUnifiedAccountClients();
    invalidateUnifiedMailboxes(b);
    await buildUnifiedAccountClients();
    expect(a.getMailboxes).toHaveBeenCalledTimes(1);
    expect(b.getMailboxes).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a live folder list with a reused one', async () => {
    const a = fakeClient('a', 5);
    connect({ a });
    await buildUnifiedAccountClients();
    // An optimistic mark-as-read lowers the live counter...
    useEmailStore.setState({ accountMailboxes: { a: [inbox('a-inbox', 4)] } });
    // ...and a later build from the cache must not bring the old 5 back.
    await buildUnifiedAccountClients();
    expect(useEmailStore.getState().accountMailboxes.a[0].unreadEmails).toBe(4);
  });

  it('publishes a list the Pro shell loaded under the JMAP id too', async () => {
    const b = fakeClient('b');
    connect({ b });
    await loadAccountMailboxes(b as unknown as IJMAPClient, 'b');
    await buildUnifiedAccountClients();
    expect(b.getMailboxes).toHaveBeenCalledTimes(1);
    // Actions on b's mail resolve its folders by JMAP id.
    expect(useEmailStore.getState().accountMailboxes['jmap-b']?.[0].id).toBe('b-inbox');
  });

  it('retries a login whose fetch failed', async () => {
    const a = fakeClient('a');
    a.getMailboxes.mockRejectedValueOnce(new Error('offline'));
    connect({ a });
    expect(await buildUnifiedAccountClients()).toHaveLength(0);
    expect(await buildUnifiedAccountClients()).toHaveLength(1);
    expect(a.getMailboxes).toHaveBeenCalledTimes(2);
  });
});
