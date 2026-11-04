import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

/**
 * A message window (desktop app, installed app) showed only the message it was
 * opened with, and r, e, # and ? did nothing there: its shortcuts waited for a
 * Pro tab to be in front, and a window has no tabs (pass-2 mail-p2-5).
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

vi.mock('@/lib/popout/window-role', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/popout/window-role')>(),
  isPopoutWindow: () => true,
}));
vi.mock('@/components/email/move-to-dialog', () => ({ MoveToDialog: () => null }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: () => {}, success: () => {} } }));
const help = vi.hoisted(() => ({ open: false }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({
  KeyboardShortcutsModal: ({ isOpen }: { isOpen: boolean }) => {
    help.open = isOpen;
    return null;
  },
}));

function selectorStore<T extends object>(state: T) {
  const hook = (sel?: (s: T) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return hook;
}

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: selectorStore({ client: null, activeAccountId: 'dso', getClientForAccount: () => undefined }),
}));
vi.mock('@/stores/email-store', () => ({
  resolveEmailBlobContext: (_email: unknown, client: unknown) => ({ client }),
  useEmailStore: selectorStore({
    fetchEmailContent: async () => null,
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
  useIdentityStore: selectorStore({ identities: [{ id: 'b', email: 'dso@example.org', name: 'Dso' }] }),
}));
const settings = vi.hoisted(() => ({ state: { singleKeyShortcuts: true, disableThreading: false } }));
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: selectorStore(settings.state) }));
vi.mock('@/stores/pro-tab-store', () => ({
  useProTabStore: selectorStore({ openComposeTab: () => {}, closeTab: () => {}, updateTabTitle: () => {} }),
}));

import { ProEmailView } from '../pro-email-tab-body';

const OLDER = {
  id: 'm1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ email: 'aylin@example.org', name: 'Aylin' }], subject: 'Question about hiring plan',
  receivedAt: '2026-10-20T08:00:00Z', preview: 'First',
};
const NEWER = {
  ...OLDER, id: 'm2', from: [{ email: 'robin@example.org', name: 'Robin' }], subject: 'Re: Question about hiring plan',
  receivedAt: '2026-10-21T08:00:00Z', preview: 'Second', keywords: {},
};
const BODY = {
  bodyValues: { '1': { value: 'Hi' } },
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [{ partId: '1', type: 'text/plain' }],
  attachments: [],
};

function makeClient() {
  return {
    getEmail: vi.fn(async (id: string) => (id === 'm1' ? { ...OLDER, ...BODY } : { ...NEWER, ...BODY })),
    getThread: vi.fn(async () => ({ id: 't1', emailIds: ['m2', 'm1'] })),
    // Not in date order: the window sorts.
    getSomeEmails: vi.fn(async () => [NEWER, OLDER]),
    markAsRead: vi.fn(async () => {}),
    getUsername: () => 'dso@example.org',
    getAccountId: () => 'a',
  };
}

describe('a message window', () => {
  beforeEach(() => {
    viewerProps.current = null;
    help.open = false;
    settings.state.disableThreading = false;
  });

  async function open() {
    const client = makeClient();
    const onOpenCompose = vi.fn(async (_data: Record<string, unknown>) => true);
    render(<ProEmailView emailId="m1" client={client as never} clientAccountId="dso" onOpenCompose={onOpenCompose} onClose={vi.fn()} conversation />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
    return { client, onOpenCompose };
  }

  it('shows the whole conversation, oldest first', async () => {
    const { client } = await open();
    await waitFor(() => expect((viewerProps.current?.mvConversation as Array<{ id: string }> | undefined)?.map((e) => e.id)).toEqual(['m1', 'm2']));
    expect(viewerProps.current?.conversationPane).toBe(true);
    expect(client.getThread).toHaveBeenCalledWith('t1', 'a');
  });

  it('keeps one message with "Show emails as individual messages"', async () => {
    settings.state.disableThreading = true;
    const { client } = await open();
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(viewerProps.current?.mvConversation).toBeUndefined();
    expect(client.getThread).not.toHaveBeenCalled();
  });

  it('replies to the message of the conversation whose button was pressed', async () => {
    const { onOpenCompose } = await open();
    await waitFor(() => expect(viewerProps.current?.mvConversation).toBeTruthy());
    await act(async () => {
      await (viewerProps.current!.onReplyConversationEmail as (e: unknown) => Promise<void>)(NEWER);
    });
    await waitFor(() => expect(onOpenCompose).toHaveBeenCalled());
    expect(onOpenCompose.mock.calls[0][0]).toMatchObject({ mode: 'reply', sourceEmailId: 'm2' });
  });

  it('marks an unfolded unread message read on the server', async () => {
    const { client } = await open();
    await waitFor(() => expect(viewerProps.current?.mvConversation).toBeTruthy());
    await act(async () => {
      (viewerProps.current!.onMarkConversationEmailRead as (e: unknown) => void)(NEWER);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(client.markAsRead).toHaveBeenCalledWith('m2', true, 'a');
  });

  it('answers r and ? with no Pro tab around it', async () => {
    const { onOpenCompose } = await open();
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR' });
    await waitFor(() => expect(onOpenCompose).toHaveBeenCalledTimes(1));
    expect(onOpenCompose.mock.calls[0][0]).toMatchObject({ mode: 'reply', sourceEmailId: 'm1' });
    fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true });
    await waitFor(() => expect(help.open).toBe(true));
  });
});
