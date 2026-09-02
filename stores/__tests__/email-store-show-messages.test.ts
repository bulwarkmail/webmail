import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Coverage for `showMessages`, the store action behind `api.search.showMessages`.
//
// A plugin that does its own retrieval (semantic search, an external index, a memory system)
// computes which messages are relevant and hands back ids. The host fetches them with the user's
// own client, so a plugin can only surface mail that user could already open, and renders them in
// the message list rather than in a panel of its own.
//
// The `label` lands in `searchQuery` deliberately: the existing Clear control is then the way back
// to the folder listing, so no new affordance is introduced for the user to learn.

function makeEmail(id: string): Email {
  return {
    id,
    subject: `Subject ${id}`,
    from: [{ email: 'sender@example.com' }],
    to: [{ email: 'recipient@example.com' }],
    receivedAt: '2026-01-01T00:00:00Z',
    keywords: {},
    hasAttachment: false,
    preview: '',
    size: 0,
    mailboxIds: { inbox: true },
    threadId: `thread-${id}`,
  } as unknown as Email;
}

function makeClient(known: string[] = []) {
  return {
    // The real client returns only the ids the session can read; an id belonging to another
    // account simply does not come back.
    getSomeEmails: vi.fn(async (ids: string[]) => ids.filter(id => known.includes(id)).map(makeEmail)),
  } as unknown as IJMAPClient;
}

describe('showMessages', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = makeClient(['m1', 'm2', 'm3']);

    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? client : undefined) as never,
    } as never);

    useSettingsStore.setState({ emailsPerPage: 50 } as never);

    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      viewingAccountId: null,
      selectedMailbox: 'inbox',
      searchMailboxId: '',
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      searchAbortController: null,
      emails: [],
      mailboxes: [],
      accountMailboxes: {},
      scheduledSubmissionByEmailId: new Map(),
      selectedEmail: null,
    } as never);
  });

  it('shows exactly the requested messages', async () => {
    await useEmailStore.getState().showMessages(client, ['m1', 'm3'], 'plugin: rate case');

    const state = useEmailStore.getState();
    expect(state.emails.map(e => e.id)).toEqual(['m1', 'm3']);
    expect(state.totalEmails).toBe(2);
    expect(state.isLoading).toBe(false);
  });

  it('puts the label in the search box, so Clear is the way back', async () => {
    await useEmailStore.getState().showMessages(client, ['m1'], 'plugin: rate case');

    expect(useEmailStore.getState().searchQuery).toBe('plugin: rate case');
  });

  it('is not folder-scoped: a plugin result set may span folders', async () => {
    useEmailStore.setState({ selectedMailbox: 'sent' } as never);
    await useEmailStore.getState().showMessages(client, ['m1', 'm2'], 'across folders');

    // getSomeEmails is called with the ids alone -- no mailbox filter narrows them.
    expect(client.getSomeEmails).toHaveBeenCalledWith(['m1', 'm2']);
    expect(useEmailStore.getState().emails).toHaveLength(2);
  });

  it('cannot surface a message the session cannot read', async () => {
    // The security property, and it is structural rather than enforced here: the fetch runs on the
    // user's own client, so an id from another account returns nothing.
    await useEmailStore.getState().showMessages(client, ['m1', 'not-mine'], 'mixed');

    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['m1']);
  });

  it('opens a single result, because there is no choice left to make', async () => {
    await useEmailStore.getState().showMessages(client, ['m2'], 'one message');

    expect(useEmailStore.getState().selectedEmail?.id).toBe('m2');
  });

  it('leaves several results closed, because choosing is the reader\'s job', async () => {
    await useEmailStore.getState().showMessages(client, ['m1', 'm2'], 'two messages');

    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it('ignores an empty id list rather than blanking the list', async () => {
    useEmailStore.setState({ emails: [makeEmail('existing')] } as never);
    await useEmailStore.getState().showMessages(client, [], 'nothing');

    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['existing']);
    expect(client.getSomeEmails).not.toHaveBeenCalled();
  });

  it('reports a fetch failure instead of leaving a spinner', async () => {
    const failing = {
      getSomeEmails: vi.fn().mockRejectedValue(new Error('JMAP down')),
    } as unknown as IJMAPClient;
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: () => failing as never,
    } as never);

    await useEmailStore.getState().showMessages(failing, ['m1'], 'will fail');

    const state = useEmailStore.getState();
    expect(state.error).toBe('JMAP down');
    expect(state.isLoading).toBe(false);
    expect(state.emails).toEqual([]);
  });

  it('leaves the folder listing intact when the user clicks a mailbox instead of Clear', async () => {
    // The label lives in `searchQuery` so the Clear control works. Selecting a folder is the
    // other way out, and it used to leave the label set -- so the next load searched for the
    // label text rather than listing the folder, and the mailbox came back empty.
    await useEmailStore.getState().showMessages(client, ['m1', 'm2'], 'plugin: rate case');
    expect(useEmailStore.getState().searchQuery).toBe('plugin: rate case');
    expect(useEmailStore.getState().isPluginList).toBe(true);

    useEmailStore.getState().selectMailbox('archive');

    expect(useEmailStore.getState().searchQuery).toBe('');
    expect(useEmailStore.getState().isPluginList).toBe(false);
    expect(useEmailStore.getState().selectedMailbox).toBe('archive');
  });

  it("does not clear a user's own search when they change folder", async () => {
    // Upstream keeps a search alive across folders on purpose; this patch must not change it.
    useEmailStore.setState({ searchQuery: 'invoice', isPluginList: false } as never);

    useEmailStore.getState().selectMailbox('archive');

    expect(useEmailStore.getState().searchQuery).toBe('invoice');
  });
});
