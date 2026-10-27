import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

/**
 * "Edit draft" on a message in a Pro folder or email tab. A draft in a group or
 * shared folder lives in that account - an undone send from the group's
 * identity goes back to the group's Drafts on Stalwart 1.0 and 0.16.23 - and
 * email ids repeat across accounts, so the composer has to know the account to
 * remove the old version there when it saves, sends or discards.
 */

const viewerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: Record<string, unknown>) => {
    viewerProps.current = props;
    return null;
  },
}));

vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  EmailViewerErrorFallback: () => null,
}));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: () => {}, success: () => {} } }));
const multiAccount = vi.hoisted(() => ({
  value: { enabled: false, groups: [] as unknown[], allIdentities: [] as Array<{ id: string; email: string; name: string }> },
}));
vi.mock('@/hooks/use-pro-multi-account-identities', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/use-pro-multi-account-identities')>(),
  useProMultiAccountIdentities: () => multiAccount.value,
}));

const { openComposeTab } = vi.hoisted(() => ({ openComposeTab: vi.fn() }));

function selectorStore<T extends object>(state: T) {
  const hook = (sel?: (s: T) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return hook;
}

// userb on the 0.16.23 server is the active login.
const auth = vi.hoisted(() => ({
  state: { client: null as unknown, activeAccountId: 'userb@v016', getClientForAccount: () => undefined },
}));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: selectorStore(auth.state),
}));
const store = vi.hoisted(() => ({ fetched: null as Record<string, unknown> | null, fetchEmailContent: vi.fn() }));
vi.mock('@/stores/email-store', () => ({
  // Where the viewer downloads parts from; not what this file tests.
  resolveEmailBlobContext: (_email: unknown, client: unknown) => ({ client }),
  useEmailStore: selectorStore({
    // An own-folder message is read through the store, not by account.
    fetchEmailContent: async (client: unknown, id: string) => {
      store.fetchEmailContent(client, id);
      return store.fetched ?? ({ ...DRAFT, id, mailboxIds: { d: true } });
    },
    deleteEmail: async () => {},
    markAsRead: async () => {},
    toggleStar: async () => {},
    moveToMailbox: async () => {},
    setEmailKeywordsLocal: () => {},
    mailboxes: [],
    emails: [],
    selectedEmail: null,
  }),
}));
vi.mock('@/stores/identity-store', () => ({
  useIdentityStore: selectorStore({ identities: [{ id: 'b', email: 'team@example.org', name: 'Team' }] }),
}));
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: selectorStore({}) }));
vi.mock('@/stores/pro-tab-store', () => ({
  useProTabStore: selectorStore({ openComposeTab, closeTab: () => {}, updateTabTitle: () => {} }),
}));

import { ProEmailView } from '../pro-email-tab-body';

const DRAFT = {
  id: 'eaaaaab',
  threadId: 't1',
  mailboxIds: { 'c:d': true },
  keywords: { $draft: true, $seen: true },
  from: [{ email: 'team@example.org', name: 'Team' }],
  to: [{ email: 'bob@example.com' }],
  subject: 'Back from undo',
  bodyValues: { '1': { value: 'Hi' } },
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [{ partId: '1', type: 'text/plain' }],
  attachments: [],
};

describe('Pro email view - editing a draft', () => {
  beforeEach(() => {
    viewerProps.current = null;
    openComposeTab.mockClear();
    multiAccount.value = { enabled: false, groups: [], allIdentities: [] };
    auth.state.client = null;
    store.fetched = null;
    store.fetchEmailContent.mockClear();
  });

  async function openAndEdit(accountId?: string, clientAccountId?: string, draft: object = DRAFT) {
    const client = { getEmail: vi.fn().mockResolvedValue(draft), getUsername: () => 'userb@example.org', getAccountId: () => 'e' };
    render(<ProEmailView emailId="eaaaaab" client={client as never} clientAccountId={clientAccountId} accountId={accountId} onClose={vi.fn()} />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
    (viewerProps.current!.onEditDraft as () => void)();
    return openComposeTab.mock.calls[0][0].initialData as Record<string, unknown>;
  }

  // userb is logged in to the Stalwart 0.16.23 and the 1.0 test server: the
  // same address, and account `e` on both. The composer removes the old
  // version through the login the draft was opened from.
  it('opens a draft of another login with that login and its identity', async () => {
    multiAccount.value = {
      enabled: true,
      groups: [],
      allIdentities: [
        { id: 'userb@v016::c', email: 'userb@example.org', name: 'userb' },
        { id: 'userb@v10::c', email: 'userb@example.org', name: 'userb' },
      ],
    };
    const ownDraft = { ...DRAFT, from: [{ email: 'userb@example.org', name: 'userb' }] };

    const initialData = await openAndEdit('e', 'userb@v10', ownDraft);

    expect(initialData).toMatchObject({ draftId: 'eaaaaab', draftAccountId: 'e', draftLocalAccountId: 'userb@v10', selectedIdentityId: 'userb@v10::c' });
  });

  it('opens a draft of a group folder with the group account', async () => {
    const initialData = await openAndEdit('c');

    expect(initialData).toMatchObject({ draftId: 'eaaaaab', draftAccountId: 'c' });
  });

  it('opens an own draft without an account, as before', async () => {
    const initialData = await openAndEdit(undefined);

    expect(initialData.draftId).toBe('eaaaaab');
    expect(initialData.draftAccountId).toBeUndefined();
  });

  // Pro shell with the 0.16.23 login active and the 1.0 login's Drafts
  // browsed: the store reads a row of that list through the 1.0 login. A
  // view that names no login can't tell, so it names none - the active one
  // made the composer destroy the draft's id in the 0.16.23 account.
  it('names no login for a draft of a view without a login of its own', async () => {
    auth.state.client = { getEmail: vi.fn(), getUsername: () => 'userb@example.org', getAccountId: () => 'e' };
    multiAccount.value = {
      enabled: true,
      groups: [],
      allIdentities: [
        { id: 'userb@v016::c', email: 'userb@example.org', name: 'userb' },
        { id: 'userb@v10::d', email: 'me@v10.example.org', name: 'Me' },
      ],
    };
    store.fetched = { ...DRAFT, from: [{ email: 'me@v10.example.org', name: 'Me' }] };

    render(<ProEmailView emailId="eaaaaab" onClose={vi.fn()} />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
    (viewerProps.current!.onEditDraft as () => void)();
    const initialData = openComposeTab.mock.calls[0][0].initialData as Record<string, unknown>;

    expect(initialData.draftLocalAccountId).toBeUndefined();
    // The draft's From decides, as for a draft of unknown origin.
    expect(initialData.selectedIdentityId).toBe('userb@v10::d');
  });

  it('reads a message of the login it names through that login\'s client, not through the main list', async () => {
    const client = { getEmail: vi.fn().mockResolvedValue(DRAFT), getUsername: () => 'userb@example.org', getAccountId: () => 'e' };

    render(<ProEmailView emailId="eaaaaab" client={client as never} clientAccountId="userb@v10" onClose={vi.fn()} />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());

    // Its own account of that login: the view names no other.
    expect(client.getEmail).toHaveBeenCalledWith('eaaaaab', 'e');
    expect(store.fetchEmailContent).not.toHaveBeenCalled();
    (viewerProps.current!.onEditDraft as () => void)();
    expect(openComposeTab.mock.calls[0][0].initialData).toMatchObject({ draftLocalAccountId: 'userb@v10', draftAccountId: undefined });
  });
});

describe('Pro email view - replying and forwarding', () => {
  beforeEach(() => {
    viewerProps.current = null;
    openComposeTab.mockClear();
    store.fetched = null;
  });

  // The answered message is flagged once the reply is sent, by then perhaps
  // with another folder open that has a message with the same id.
  it.each(['onReply', 'onReplyAll', 'onForward'])('names the login and account of the message (%s)', async (action) => {
    const client = { getEmail: vi.fn().mockResolvedValue(DRAFT), getUsername: () => 'userb@example.org', getAccountId: () => 'e' };
    render(<ProEmailView emailId="eaaaaab" client={client as never} clientAccountId="userb@v10" accountId="c" onClose={vi.fn()} />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());

    (viewerProps.current![action] as () => void)();

    expect(openComposeTab.mock.calls[0][0]).toMatchObject({
      sourceEmailId: 'eaaaaab',
      sourceEmailSource: { clientAccountId: 'userb@v10', accountId: 'c' },
    });
  });

  it('names the active login for a message read through it', async () => {
    auth.state.client = { getEmail: vi.fn(), getUsername: () => 'userb@example.org', getAccountId: () => 'e' };
    render(<ProEmailView emailId="eaaaaab" onClose={vi.fn()} />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());

    (viewerProps.current!.onReply as () => void)();

    expect(openComposeTab.mock.calls[0][0].sourceEmailSource).toEqual({ clientAccountId: 'userb@v016', accountId: undefined });
  });
});
