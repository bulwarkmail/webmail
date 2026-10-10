import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, resolveSelectedEmails } from '../email-store';
import { useAuthStore } from '../auth-store';
import { emailKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * Batch actions over a selection that holds a namesake: the same email id in
 * two accounts of the unified view. Each action must reach the account of the
 * row that was ticked, through that account's client, and leave the other
 * account's message alone.
 */
const twin = (account: string, overrides: Partial<Email> = {}): Email => ({
  id: 'eiaaaabc', threadId: 'taaaabc', blobId: `blob-${account}`,
  mailboxIds: { [`inbox-${account}`]: true }, keywords: {},
  from: [{ email: `someone@${account}` }], to: [], subject: account,
  receivedAt: '2026-09-19T08:00:00Z', size: 42, preview: '', hasAttachment: false,
  sourceClientAccountId: account, sourceAccountId: account,
  ...overrides,
} as unknown as Email);

const mailbox = (overrides: Partial<Mailbox>): Mailbox => ({
  id: 'inbox', name: 'Inbox', sortOrder: 0,
  totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: {
    mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
    maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
  },
  isSubscribed: true, isShared: false,
  ...overrides,
} as Mailbox);

const makeClient = () => ({
  batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
  batchMoveEmails: vi.fn().mockResolvedValue(undefined),
  batchMarkAsRead: vi.fn().mockResolvedValue(undefined),
  getMailboxes: vi.fn().mockResolvedValue([]),
}) as unknown as IJMAPClient & Record<string, ReturnType<typeof vi.fn>>;

const a = twin('account-a');
const b = twin('account-b');
let clientA: ReturnType<typeof makeClient>;
let clientB: ReturnType<typeof makeClient>;

beforeEach(() => {
  clientA = makeClient();
  clientB = makeClient();
  useAuthStore.setState({
    activeAccountId: 'account-a',
    client: clientA,
    getClientForAccount: (id: string) =>
      (id === 'account-a' ? clientA : id === 'account-b' ? clientB : undefined) as never,
  } as never);
  useEmailStore.setState({
    isUnifiedView: true,
    selectedMailbox: '',
    selectedKeyword: null,
    emails: [a, b],
    threadEmailsCache: new Map(),
    selectedEmailKeys: new Set(),
    lastSelectedEmailKey: null,
    mailboxes: [],
    accountMailboxes: {
      'account-a': [mailbox({ id: 'trash-a', name: 'Trash', role: 'trash', accountId: 'account-a' })],
      'account-b': [mailbox({ id: 'trash-b', name: 'Trash', role: 'trash', accountId: 'account-b' })],
    },
    error: null,
  });
});

describe('batch actions with a namesake in another account', () => {
  it('permanently deletes only the ticked account copy', async () => {
    useEmailStore.getState().toggleEmailSelection(b);
    await useEmailStore.getState().batchDelete(clientA, true);

    expect(clientB.batchDeleteEmails).toHaveBeenCalledWith(['eiaaaabc'], 'account-b');
    expect(clientA.batchDeleteEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map(e => e.sourceAccountId)).toEqual(['account-a']);
  });

  it('moves only the ticked account copy to its own trash', async () => {
    useEmailStore.getState().toggleEmailSelection(b);
    await useEmailStore.getState().batchDelete(clientA);

    expect(clientB.batchMoveEmails).toHaveBeenCalledWith(['eiaaaabc'], 'trash-b', 'account-b', false);
    expect(clientA.batchMoveEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map(e => e.sourceAccountId)).toEqual(['account-a']);
  });

  it('keeps the namesake whose account has no trash when the other one moved', async () => {
    useEmailStore.setState({
      accountMailboxes: {
        'account-a': [],
        'account-b': [mailbox({ id: 'trash-b', name: 'Trash', role: 'trash', accountId: 'account-b' })],
      },
    });
    useEmailStore.getState().selectAllEmails();
    await useEmailStore.getState().batchDelete(clientA);

    expect(clientB.batchMoveEmails).toHaveBeenCalledTimes(1);
    expect(clientA.batchMoveEmails).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.emails.map(e => e.sourceAccountId)).toEqual(['account-a']);
    expect(state.error).toMatch(/trash folder missing/);
  });

  it('marks only the ticked account copy read', async () => {
    useEmailStore.getState().toggleEmailSelection(b);
    await useEmailStore.getState().batchMarkAsRead(clientA, true);

    expect(clientB.batchMarkAsRead).toHaveBeenCalledWith(['eiaaaabc'], true, 'account-b');
    expect(clientA.batchMarkAsRead).not.toHaveBeenCalled();
    const [rowA, rowB] = useEmailStore.getState().emails;
    expect(rowA.keywords.$seen).toBeUndefined();
    expect(rowB.keywords.$seen).toBe(true);
  });

  it('copies the ticked account copy from its own account', async () => {
    const crossAccountMoveEmails = vi.fn().mockResolvedValue(undefined);
    useEmailStore.setState({ crossAccountMoveEmails });
    await useEmailStore.getState().copyEmailsToAccount([b], 'account-c', 'dest');

    expect(crossAccountMoveEmails).toHaveBeenCalledTimes(1);
    const [bySource, , , , sourceJmap] = crossAccountMoveEmails.mock.calls[0];
    expect([...bySource]).toEqual([['account-b', ['eiaaaabc']]]);
    expect(sourceJmap).toBe('account-b');
  });
});

describe('selection reaching expanded thread members', () => {
  const row = { ...a, id: 'row', threadId: 'thr' } as Email;
  const member = { ...a, id: 'member', threadId: 'thr' } as Email;

  it('resolves a ticked member that is not a list row, once', () => {
    const state = {
      emails: [row],
      threadEmailsCache: new Map([['k', [row, member]]]),
      selectedEmailKeys: new Set([emailKeyFor(row), emailKeyFor(member)]),
    };
    expect(resolveSelectedEmails(state).map(e => e.id)).toEqual(['row', 'member']);
  });

  it('deletes a ticked member that lives outside the list', async () => {
    useEmailStore.setState({
      emails: [row],
      threadEmailsCache: new Map([['account-a/account-a:thr', [row, member]]]),
      selectedEmailKeys: new Set([emailKeyFor(member)]),
    });
    await useEmailStore.getState().batchDelete(clientA, true);

    expect(clientA.batchDeleteEmails).toHaveBeenCalledWith(['member'], 'account-a');
  });
});
