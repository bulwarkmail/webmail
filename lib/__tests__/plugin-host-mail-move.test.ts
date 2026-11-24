import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'mover', name: 'Mover', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const WRITER = plugin(['email:write']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const archive = { id: 'arch', name: 'Archive', role: 'archive' } as Mailbox;
const shared = { id: 'acc2:box', name: 'Team', isShared: true, accountId: 'acc2' } as unknown as Mailbox;
let move: ReturnType<typeof vi.fn>;
const client = {} as IJMAPClient;
const storeMove = useEmailStore.getState().moveEmailsToMailbox;
const getClientForAccount = useAuthStore.getState().getClientForAccount;

beforeEach(() => {
  resetPluginRateLimits();
  move = vi.fn(async () => {});
  useAuthStore.setState({ client });
  useEmailStore.setState({
    mailboxes: [inbox, archive, shared], moveEmailsToMailbox: move,
    selectedMailbox: 'inbox', isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, emails: [],
  } as never);
});
afterEach(() => {
  useAuthStore.setState({ client: null, activeAccountId: null, getClientForAccount });
});

describe('api.email.move and archive', () => {
  it('moves through the store, so the hooks and the list follow', async () => {
    await call(WRITER, 'email.move', ['m1', 'm2', 'm1'], 'inbox');
    await call(WRITER, 'email.archive', ['m3']);

    expect(move).toHaveBeenNthCalledWith(1, client, ['m1', 'm2'], 'inbox');
    expect(move).toHaveBeenNthCalledWith(2, client, ['m3'], 'arch');
  });

  it('refuses unknown or shared folders, empty and huge lists, and plugins without email:write', async () => {
    await expect(call(WRITER, 'email.move', ['m1'], 'nope')).rejects.toThrow(/no folder/);
    await expect(call(WRITER, 'email.move', ['m1'], 'acc2:box')).rejects.toThrow(/no folder/);
    await expect(call(WRITER, 'email.move', [], 'inbox')).rejects.toThrow(/non-empty/);
    await expect(call(WRITER, 'email.move', Array.from({ length: 101 }, (_, i) => `m${i}`), 'inbox')).rejects.toThrow(/at most 100/);
    await expect(call(plugin(['email:read']), 'email.archive', ['m1'])).rejects.toThrow(/lacks permission "email:write"/);
    expect(move).not.toHaveBeenCalled();
  });

  // Ids repeat across accounts: the group's Inbox holds its own "m1" and
  // "m2". The store moves in the account of the folder that is open.
  it.each([
    ['a shared or group folder is open', { selectedMailbox: 'acc2:box' }],
    ['a unified view is open', { isUnifiedView: true }],
    ['another login is open', { viewingAccountId: 'login-2' }],
  ])('moves no other account\'s messages while %s', async (_label, view) => {
    const batchMoveEmails = vi.fn(async () => {});
    const moveEmail = vi.fn(async () => {});
    const own = { batchMoveEmails, moveEmail } as unknown as IJMAPClient;
    useAuthStore.setState({ client: own, activeAccountId: 'login-1', getClientForAccount: () => own } as never);
    const row = (id: string) => ({ id, threadId: id, mailboxIds: { box: true }, keywords: {}, sourceClientAccountId: 'login-1', sourceAccountId: 'acc2' });
    useEmailStore.setState({ moveEmailsToMailbox: storeMove, emails: [row('m1'), row('m2')], ...view } as never);

    await expect(call(WRITER, 'email.move', ['m1', 'm2'], 'arch')).rejects.toThrow(/open a folder of this account/);
    await expect(call(WRITER, 'email.archive', ['m1'])).rejects.toThrow(/open a folder of this account/);
    expect(batchMoveEmails).not.toHaveBeenCalled();
    expect(moveEmail).not.toHaveBeenCalled();
  });

  // An auto-filer moves new mail while the user looks at another folder.
  it('moves a single message that is not in the open list', async () => {
    const batchMoveEmails = vi.fn(async () => {});
    const moveEmail = vi.fn(async () => {});
    useAuthStore.setState({ client: { batchMoveEmails, moveEmail } as unknown as IJMAPClient });
    useEmailStore.setState({ moveEmailsToMailbox: storeMove, emails: [] } as never);

    await call(WRITER, 'email.move', ['m9'], 'arch');

    expect([...batchMoveEmails.mock.calls, ...moveEmail.mock.calls]).toEqual([[['m9'], 'arch', undefined]]);
  });

  it('says when there is no Archive folder', async () => {
    useEmailStore.setState({ mailboxes: [inbox] });
    await expect(call(WRITER, 'email.archive', ['m1'])).rejects.toThrow(/no Archive folder/);
  });

  describe('in a shared or team account', () => {
    const teamArchive = { id: 'acc2:arch', originalId: 'arch', name: 'Archive', role: 'archive', isShared: true, accountId: 'acc2', myRights: { mayAddItems: true } } as unknown as Mailbox;
    const teamInbox = { id: 'acc2:in', originalId: 'in', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'acc2', myRights: { mayAddItems: true } } as unknown as Mailbox;
    const ownRow = (id: string) => ({ id, threadId: id, mailboxIds: { inbox: true }, keywords: {} });
    let moveEmail: ReturnType<typeof vi.fn>;
    let batchMoveEmails: ReturnType<typeof vi.fn>;
    let readOnly: boolean;

    beforeEach(() => {
      moveEmail = vi.fn(async () => {});
      batchMoveEmails = vi.fn(async () => {});
      readOnly = false;
      const own = {
        batchMoveEmails, moveEmail, getAccountId: () => 'acc1',
        getAccountInfo: (id: string) => (id === 'acc2' ? { name: 'team@example.org', isPersonal: false, isReadOnly: readOnly, accountCapabilities: {} } : null),
      } as unknown as IJMAPClient;
      useAuthStore.setState({ client: own, activeAccountId: 'login-1', getClientForAccount: (id: string) => (id === 'login-1' ? own : undefined) } as never);
      // The own Inbox is open; its "m1" is another message than the team's "m1".
      useEmailStore.setState({
        moveEmailsToMailbox: storeMove, mailboxes: [inbox, archive, shared, teamArchive, teamInbox],
        accountMailboxes: {}, emails: [ownRow('m1')], selectedEmail: null,
      } as never);
    });

    it('archives into that account\'s Archive while the own Inbox is open', async () => {
      await call(WRITER, 'email.archive', ['m1'], 'acc2');

      expect(moveEmail).toHaveBeenCalledExactlyOnceWith('m1', 'arch', 'acc2');
      expect(batchMoveEmails).not.toHaveBeenCalled();
      // The own message with the same id stays listed.
      expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['m1']);
    });

    it('takes ids as { id, accountId } and a folder by its id in the list or on the server', async () => {
      await call(WRITER, 'email.move', [{ id: 'm1', accountId: 'acc2' }, { id: 'm2', accountId: 'acc2' }], 'acc2:in');
      await call(WRITER, 'email.move', ['m3'], 'in', 'acc2');

      expect(moveEmail.mock.calls).toEqual([['m1', 'in', 'acc2'], ['m2', 'in', 'acc2'], ['m3', 'in', 'acc2']]);
    });

    it('moves in one batch through the open list when a folder of that account is open', async () => {
      useEmailStore.setState({ selectedMailbox: 'acc2:in', emails: [] } as never);

      await call(WRITER, 'email.archive', ['m1', 'm2'], 'acc2');

      expect(batchMoveEmails).toHaveBeenCalledExactlyOnceWith(['m1', 'm2'], 'arch', 'acc2');
    });

    it('moves the own messages it names by the own account while a team folder is open', async () => {
      useEmailStore.setState({ selectedMailbox: 'acc2:in', emails: [] } as never);

      await call(WRITER, 'email.archive', [{ id: 'm1', accountId: 'acc1' }]);

      expect(moveEmail).toHaveBeenCalledExactlyOnceWith('m1', 'arch', undefined);
    });

    it('refuses accounts it doesn\'t show, read-only accounts and folders the user may not add to', async () => {
      await expect(call(WRITER, 'email.archive', ['m1'], 'acc9')).rejects.toThrow(/no account "acc9"/);
      await expect(call(WRITER, 'email.move', ['m1'], 'inbox', 'acc2')).rejects.toThrow(/no folder with id "inbox" in the account "acc2"/);
      await expect(call(WRITER, 'email.move', [{ id: 'm1', accountId: 'acc2' }, 'm2'], 'acc2:in')).rejects.toThrow(/one account/);
      await expect(call(WRITER, 'email.move', [{ id: 'm1', accountId: 'acc3' }], 'acc2:in', 'acc2')).rejects.toThrow(/one account/);
      await expect(call(WRITER, 'email.move', [{ id: 'm1', extra: 1 }], 'inbox')).rejects.toThrow(/unknown property "extra"/);

      useEmailStore.setState({ mailboxes: [inbox, { ...teamArchive, myRights: { mayAddItems: false } }] } as never);
      await expect(call(WRITER, 'email.archive', ['m1'], 'acc2')).rejects.toThrow(/may not add messages to "Archive"/);

      readOnly = true;
      useEmailStore.setState({ mailboxes: [inbox, teamArchive] } as never);
      await expect(call(WRITER, 'email.archive', ['m1'], 'acc2')).rejects.toThrow(/may only read/);
      expect(moveEmail).not.toHaveBeenCalled();
      expect(batchMoveEmails).not.toHaveBeenCalled();
    });

    it('says when that account has no Archive folder', async () => {
      useEmailStore.setState({ mailboxes: [inbox, archive, teamInbox] } as never);
      await expect(call(WRITER, 'email.archive', ['m1'], 'acc2')).rejects.toThrow(/account "acc2" has no Archive folder/);
    });
  });

  it('limits how often a plugin moves mail', async () => {
    for (let i = 0; i < 20; i++) await call(WRITER, 'email.move', ['m1'], 'inbox');
    await expect(call(WRITER, 'email.move', ['m1'], 'inbox')).rejects.toThrow(/too many moves/);
  });
});
