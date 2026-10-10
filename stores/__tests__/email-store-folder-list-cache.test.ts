import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { forgetFolderLists } from '@/lib/folder-list-cache';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * Opening a folder paints the rows it showed last time and loads the fresh
 * page behind them, so a slow server does
 * not hold the previous folder's mail under a spinner - and a failed load
 * does not empty a folder that had mail a moment ago.
 */

const makeEmail = (id: string, extra: Partial<Email> = {}): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    subject: `mail ${id}`,
    receivedAt: '2026-10-08T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
    ...extra,
  }) as unknown as Email;

const folder = (id: string, role: string | null) =>
  ({
    id,
    originalId: id,
    name: id,
    role,
    accountId: 'acc',
    totalEmails: 2,
    unreadEmails: 0,
    totalThreads: 2,
    unreadThreads: 0,
    sortOrder: 0,
    isSubscribed: true,
    myRights: {},
  }) as unknown as Mailbox;

type Page = { emails: Email[]; hasMore: boolean; total: number; state?: string };

function makeClient(pages: Record<string, () => Promise<Page>>) {
  const getEmails = vi.fn((mailboxId: string) => pages[mailboxId]());
  return {
    client: {
      getEmails,
      getAccountId: () => 'acc',
      getThreadEmails: vi.fn(async () => []),
    } as unknown as IJMAPClient,
    getEmails,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ids = () => useEmailStore.getState().emails.map((e) => e.id);

async function open(client: IJMAPClient, mailboxId: string) {
  useEmailStore.getState().selectMailbox(mailboxId);
  return useEmailStore.getState().fetchEmails(client, mailboxId);
}

describe('remembered folder lists', () => {
  beforeEach(() => {
    forgetFolderLists();
    useSettingsStore.setState({ emailsPerPage: 50 });
    useEmailStore.setState({
      selectedMailbox: 'inbox',
      mailboxes: [folder('inbox', 'inbox'), folder('work', null)],
      accountMailboxes: {},
      viewingAccountId: null,
      emails: [],
      totalEmails: 0,
      hasMoreEmails: false,
      emailListSync: null,
      isUnifiedView: false,
      isScheduledView: false,
      selectedKeyword: null,
      searchQuery: '',
      isLoading: false,
      error: null,
    });
  });

  it('paints a visited folder at once and replaces it when the fresh page lands', async () => {
    const fresh = deferred<Page>();
    let inboxCalls = 0;
    const { client } = makeClient({
      inbox: () =>
        ++inboxCalls === 1
          ? Promise.resolve({ emails: [makeEmail('a'), makeEmail('b')], hasMore: false, total: 2, state: 's1' })
          : fresh.promise,
      work: async () => ({ emails: [makeEmail('w')], hasMore: false, total: 1, state: 's1' }),
    });

    await open(client, 'inbox');
    await open(client, 'work');
    expect(ids()).toEqual(['w']);

    const loading = open(client, 'inbox');
    expect(ids()).toEqual(['a', 'b']);
    expect(useEmailStore.getState().isLoading).toBe(false);

    fresh.resolve({ emails: [makeEmail('new'), makeEmail('a'), makeEmail('b')], hasMore: false, total: 3, state: 's2' });
    await loading;
    expect(ids()).toEqual(['new', 'a', 'b']);
    expect(useEmailStore.getState().emailListSync?.state).toBe('s2');
  });

  it('keeps the remembered rows when the refresh fails', async () => {
    let inboxCalls = 0;
    const { client } = makeClient({
      inbox: async () => {
        if (++inboxCalls > 1) throw new Error('rate limited; retry later');
        return { emails: [makeEmail('a')], hasMore: false, total: 1, state: 's1' };
      },
      work: async () => ({ emails: [makeEmail('w')], hasMore: false, total: 1, state: 's1' }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await open(client, 'inbox');
    await open(client, 'work');
    await open(client, 'inbox');

    expect(ids()).toEqual(['a']);
    expect(useEmailStore.getState().error).toBe('rate limited; retry later');
  });

  it('remembers what happened to the list on screen, not the list as it was loaded', async () => {
    const { client } = makeClient({
      inbox: async () => ({ emails: [makeEmail('a'), makeEmail('b')], hasMore: false, total: 2, state: 's1' }),
      work: async () => ({ emails: [makeEmail('w')], hasMore: false, total: 1, state: 's1' }),
    });

    await open(client, 'inbox');
    useEmailStore.setState({ emails: [makeEmail('a', { keywords: { $seen: true } })], totalEmails: 1 });
    await open(client, 'work');

    useEmailStore.getState().selectMailbox('inbox');
    void useEmailStore.getState().fetchEmails(client, 'inbox');
    expect(ids()).toEqual(['a']);
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true });
  });

  it('shows the spinner for a folder never opened in this tab', async () => {
    const fresh = deferred<Page>();
    const { client } = makeClient({
      inbox: async () => ({ emails: [makeEmail('a')], hasMore: false, total: 1, state: 's1' }),
      work: () => fresh.promise,
    });

    await open(client, 'inbox');
    const loading = open(client, 'work');
    expect(useEmailStore.getState().isLoading).toBe(true);
    // The inbox rows stay up during the transition but are not this folder's.
    fresh.resolve({ emails: [makeEmail('w')], hasMore: false, total: 1, state: 's1' });
    await loading;
    expect(ids()).toEqual(['w']);
  });
});
