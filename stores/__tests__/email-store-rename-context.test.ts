import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mailbox(accountId: string, name: string): Mailbox {
  return { id: 'folder', name, accountId, isShared: false } as Mailbox;
}
function client(accountId: string) {
  return {
    getAccountId: () => accountId,
    getServerUrl: () => 'https://mail.example.test',
    updateMailbox: vi.fn<(...args: Parameters<IJMAPClient['updateMailbox']>) => Promise<void>>(),
  };
}
let pending: ReturnType<typeof deferred>;
let a: ReturnType<typeof client>;
let b: ReturnType<typeof client>;
const asClient = (c: ReturnType<typeof client>) => c as unknown as IJMAPClient;

beforeEach(() => {
  clearAllHooks();
  pending = deferred(); a = client('jmap-a'); b = client('jmap-b');
  a.updateMailbox.mockImplementation(() => pending.promise);
  useAuthStore.setState({ activeAccountId: 'login-a', client: asClient(a),
    getClientForAccount: (id: string) => id === 'login-a' ? asClient(a) : asClient(b),
    getAllConnectedClients: () => new Map([['login-a', asClient(a)], ['login-b', asClient(b)]]),
  } as never);
  useEmailStore.setState({ viewingAccountId: null, mailboxes: [mailbox('jmap-a', 'A')],
    accountMailboxes: { 'login-b': [mailbox('jmap-b', 'B')] }, selectedMailbox: 'folder', error: null });
});
afterEach(() => clearAllHooks());

describe('rename completion belongs to its captured context', () => {
  it.each(['client', 'viewing', 'owner', 'owner-client'] as const)('does not patch a changed %s context, but reports confirmed server success', async (change) => {
    if (change === 'owner-client') useEmailStore.setState({ mailboxes: [{ ...mailbox('jmap-b', 'Shared'), isShared: true }] });
    const written = change === 'owner-client' ? b : a;
    written.updateMailbox.mockImplementation(() => pending.promise);
    const observer = vi.fn(); emailHooks.onMailboxRename.register('test', observer);
    const run = useEmailStore.getState().renameMailbox(asClient(a), 'folder', 'Renamed');
    if (change === 'client') useAuthStore.setState({ client: asClient(client('jmap-a')) });
    if (change === 'viewing') useEmailStore.getState().selectAccountMailbox('login-b', 'folder');
    if (change === 'owner') useEmailStore.getState().setMailboxes([mailbox('other-owner', 'Refreshed')]);
    if (change === 'owner-client') useAuthStore.setState({ getAllConnectedClients: () => new Map([['replacement', asClient(client('jmap-b'))]]) } as never);
    const before = useEmailStore.getState();
    pending.resolve();
    expect(await run).toBe(true);
    expect(useEmailStore.getState().mailboxes).toEqual(before.mailboxes);
    expect(useEmailStore.getState().accountMailboxes).toEqual(before.accountMailboxes);
    expect(observer).toHaveBeenCalledExactlyOnceWith({ mailboxId: 'folder', name: 'Renamed', previousName: change === 'owner-client' ? 'Shared' : 'A' });
  });
  it.each(['client', 'viewing', 'owner'] as const)('does not write a late failure into a changed %s context', async (change) => {
    const run = useEmailStore.getState().renameMailbox(asClient(a), 'folder', 'Renamed');
    const rejected = expect(run).rejects.toThrow('Refused');
    if (change === 'client') useAuthStore.setState({ client: asClient(client('jmap-a')) });
    if (change === 'viewing') useEmailStore.getState().selectAccountMailbox('login-b', 'folder');
    if (change === 'owner') useEmailStore.getState().setMailboxes([mailbox('other-owner', 'Refreshed')]);
    useEmailStore.getState().setError('Current error');
    pending.reject(new Error('Refused')); await rejected;
    expect(useEmailStore.getState().error).toBe('Current error');
  });
  it('keeps shared-owner routing and successful notification when navigating within the account', async () => {
    useEmailStore.setState({ mailboxes: [{ ...mailbox('shared-owner', 'Shared'), id: 'shared-owner:folder', originalId: 'folder', isShared: true }] });
    const observer = vi.fn(); emailHooks.onMailboxRename.register('test', observer);
    const run = useEmailStore.getState().renameMailbox(asClient(a), 'shared-owner:folder', 'Renamed');
    useEmailStore.getState().selectMailbox('other');
    pending.resolve(); expect(await run).toBe(true);
    expect(a.updateMailbox).toHaveBeenCalledWith('folder', { name: 'Renamed' }, 'shared-owner');
    expect(useEmailStore.getState().mailboxes[0]).toMatchObject({ id: 'shared-owner:folder', name: 'Renamed', accountId: 'shared-owner', isShared: true });
    expect(observer).toHaveBeenCalledExactlyOnceWith({ mailboxId: 'shared-owner:folder', name: 'Renamed', previousName: 'Shared' });
    expect(useEmailStore.getState().selectedMailbox).toBe('other');
  });
});
