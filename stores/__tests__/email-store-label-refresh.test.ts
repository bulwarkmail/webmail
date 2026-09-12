import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useMessageListTabsStore } from '../message-list-tabs-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const label = 'GoogleVoice';
const keyword = `$label:${label}`;
const inbox = { id: 'inbox', role: 'inbox', isShared: false } as Mailbox;

function email(id: string, tagged = true, mailbox = 'inbox'): Email {
  return {
    id, threadId: `thread-${id}`, mailboxIds: { [mailbox]: true },
    keywords: tagged ? { [keyword]: true } : {},
    subject: id, receivedAt: '2026-09-12T00:00:00Z',
    from: [{ email: 'sender@example.com' }], to: [],
    preview: '', size: 1, hasAttachment: false,
  } as Email;
}

function clientFor(rows: Email[]) {
  const getEmails = vi.fn<IJMAPClient['getEmails']>(async (
    mailboxId?: string, _accountId?: string, limit = 2, position = 0, hasKeyword?: string,
  ) => {
    const matches = rows.filter(row =>
      (!mailboxId || row.mailboxIds[mailboxId]) && (!hasKeyword || row.keywords[hasKeyword]),
    );
    return {
      emails: matches.slice(position, position + limit),
      total: matches.length,
      hasMore: position + limit < matches.length,
      state: 'email-state',
    };
  });
  return {
    getEmails,
    getThreads: vi.fn(async () => []),
    getAccountId: () => 'gmail-account',
  } as unknown as IJMAPClient & { getEmails: typeof getEmails };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('label views during refresh and navigation', () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState());
    useSettingsStore.setState({ emailsPerPage: 2, emailKeywords: [], messageListOrder: [], messageListOrderScope: 'inbox' });
    useEmailStore.setState({
      ...useEmailStore.getInitialState(),
      selectedMailbox: 'inbox', selectedKeyword: label, mailboxes: [inbox],
    });
  });

  it('keeps only the selected label across folders after an Email state push', async () => {
    const voice = email('voice');
    const archived = email('archived-voice', true, 'archive');
    const client = clientFor([email('aws', false), voice, archived, email('apple', false)]);

    await useEmailStore.getState().fetchEmails(client);
    expect(useEmailStore.getState().emails).toEqual([voice, archived]);

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { 'gmail-account': { Email: '2' } },
    }, client);

    expect(useEmailStore.getState().emails).toEqual([voice, archived]);
    expect(useEmailStore.getState().totalEmails).toBe(2);
    expect(useEmailStore.getState().hasMoreEmails).toBe(false);
    expect(useEmailStore.getState().newEmailNotification).toBeNull();
    // Label results cannot be used as a plain-folder Email/changes baseline.
    expect(useEmailStore.getState().emailListSync).toBeNull();
  });

  it('preserves loaded label pages when refreshing the first page', async () => {
    const rows = [email('voice-1'), email('voice-2'), email('voice-3', true, 'archive')];
    const client = clientFor([email('aws', false), ...rows]);
    await useEmailStore.getState().fetchEmails(client);
    await useEmailStore.getState().loadMoreEmails(client);
    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails).toEqual(rows);
    expect(useEmailStore.getState().totalEmails).toBe(3);
    expect(useEmailStore.getState().hasMoreEmails).toBe(false);
  });

  it('keeps an empty label empty when unrelated inbox messages arrive', async () => {
    useEmailStore.getState().selectKeyword('empty-label');
    await useEmailStore.getState().refreshCurrentMailbox(clientFor([email('aws', false)]));

    expect(useEmailStore.getState().emails).toEqual([]);
    expect(useEmailStore.getState().totalEmails).toBe(0);
  });

  it('can refresh a selected label without a selected mailbox', async () => {
    const voice = email('voice', true, 'archive');
    useEmailStore.setState({ selectedMailbox: '' });
    await useEmailStore.getState().refreshCurrentMailbox(clientFor([voice]));
    expect(useEmailStore.getState().emails).toEqual([voice]);
  });

  it('returns to normal folder filtering when the label is cleared', async () => {
    const aws = email('aws', false);
    useEmailStore.getState().selectMailbox('inbox');
    await useEmailStore.getState().refreshCurrentMailbox(clientFor([aws, email('archived', true, 'archive')]));
    expect(useEmailStore.getState().emails).toEqual([aws]);
    expect(useEmailStore.getState().emailListSync?.mailboxId).toBe('inbox');
  });

  it('retains the shared account scope while querying a label across folders', async () => {
    const sharedInbox = { ...inbox, id: 'owner:inbox', originalId: 'inbox', isShared: true, accountId: 'owner' };
    useEmailStore.setState({ selectedMailbox: sharedInbox.id, mailboxes: [sharedInbox] });
    const client = clientFor([email('voice')]);
    await useEmailStore.getState().refreshCurrentMailbox(client);
    expect(client.getEmails).toHaveBeenCalledWith(undefined, 'owner', 2, 0, keyword, true, undefined, []);
  });

  it('uses the tag list order instead of the previous inbox order', async () => {
    useSettingsStore.setState({ messageListOrder: [{ criterion: 'from', direction: 'asc' }], messageListOrderScope: 'inbox' });
    const client = clientFor([email('voice')]);
    await useEmailStore.getState().fetchEmails(client);
    await useEmailStore.getState().refreshCurrentMailbox(client);
    expect(client.getEmails.mock.calls[1]).toEqual(client.getEmails.mock.calls[0]);
  });

  it.each(['refresh', 'fetch', 'pagination'] as const)(
    'ignores an old %s response after switching labels', async (operation) => {
      const voice = email('voice');
      const notes = { ...email('notes'), keywords: { '$label:Notes': true } };
      useEmailStore.setState({ emails: [voice], totalEmails: 3, hasMoreEmails: true });
      const client = clientFor([]);
      const pending = deferred<Awaited<ReturnType<IJMAPClient['getEmails']>>>();
      client.getEmails.mockImplementationOnce(() => pending.promise);

      const state = useEmailStore.getState();
      const request = operation === 'refresh' ? state.refreshCurrentMailbox(client)
        : operation === 'fetch' ? state.fetchEmails(client) : state.loadMoreEmails(client);
      useEmailStore.getState().selectKeyword('Notes');
      useEmailStore.setState({ emails: [notes], totalEmails: 1, hasMoreEmails: false, isLoading: false });
      pending.resolve({ emails: [voice], total: 3, hasMore: true });
      await request;

      expect(useEmailStore.getState().emails).toEqual([notes]);
      expect(useEmailStore.getState().totalEmails).toBe(1);
      expect(useEmailStore.getState().hasMoreEmails).toBe(false);
      expect(useEmailStore.getState().isLoadingMore).toBe(false);
    },
  );

  it('ignores a folder refresh that finishes after selecting a label', async () => {
    useEmailStore.getState().selectMailbox('inbox');
    const client = clientFor([]);
    const pending = deferred<Awaited<ReturnType<IJMAPClient['getEmails']>>>();
    client.getEmails.mockImplementationOnce(() => pending.promise);
    const request = useEmailStore.getState().refreshCurrentMailbox(client);
    const voice = email('voice');
    useEmailStore.getState().selectKeyword(label);
    useEmailStore.setState({ emails: [voice], totalEmails: 1 });
    pending.resolve({ emails: [email('aws', false)], total: 1, hasMore: false });
    await request;
    expect(useEmailStore.getState().emails).toEqual([voice]);
  });
});
