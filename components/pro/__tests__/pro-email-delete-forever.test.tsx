import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

/**
 * mail-p3-1: Delete forever in a message window opened from Trash closed the
 * window at once, asked nothing and left the message in Trash: the view
 * called the store's delete without saying it was for good, so the store
 * "moved" the message to the Trash it was already in, and the main window
 * then toasted "Email deleted". The view now asks the main window's question,
 * deletes for good, and closes only once that worked.
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
vi.mock('next-intl', () => ({ useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key), useLocale: () => 'en' }));
const toasts = vi.hoisted(() => ({ errors: [] as string[] }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: (title: string) => toasts.errors.push(title), success: () => {} } }));
vi.mock('@/lib/mail-removal-confirm', () => ({ confirmMailRemoval: async () => true }));

const asked = vi.hoisted(() => ({ questions: [] as Array<Record<string, unknown>>, answer: true }));
vi.mock('@/hooks/use-confirm-dialog', () => ({
  useConfirmDialog: () => ({
    dialogProps: {},
    confirm: async (options: Record<string, unknown>) => {
      asked.questions.push(options);
      return asked.answer;
    },
  }),
}));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));

const calls = vi.hoisted(() => ({ order: [] as string[], offer: [] as unknown[][], deleteArgs: [] as unknown[][], fail: false }));
vi.mock('@/lib/popout/moved-undo', () => ({
  offerMoveUndo: async (...args: unknown[]) => {
    calls.order.push(`offer:${args[0]}`);
    calls.offer.push(args);
  },
}));
vi.mock('@/lib/popout/window-role', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/popout/window-role')>(),
  isPopoutWindow: () => true,
}));

function selectorStore<T extends object>(state: T) {
  const hook = (sel?: (s: T) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return hook;
}

const auth = vi.hoisted(() => ({ state: { client: null as unknown, activeAccountId: 'alice', getClientForAccount: () => undefined } }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: selectorStore(auth.state) }));

const MESSAGE = vi.hoisted(() => ({
  id: 'm1',
  threadId: 't1',
  mailboxIds: { trash: true } as Record<string, boolean>,
  keywords: { $seen: true },
  from: [{ email: 'sam@example.org', name: 'Sam' }],
  to: [{ email: 'me@example.org' }],
  subject: 'Old news',
  bodyValues: { '1': { value: 'Hi' } },
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [{ partId: '1', type: 'text/plain' }],
  attachments: [],
}));
const store = vi.hoisted(() => ({ selectedMailbox: 'trash' }));
vi.mock('@/stores/email-store', () => ({
  resolveEmailBlobContext: (_email: unknown, client: unknown) => ({ client }),
  restoreBatchesFor: (emails: Array<{ id: string }>, client: unknown) => [{ client, points: emails.map((e) => ({ id: e.id })) }],
  // The real rule's Trash part: deleting there destroys the mail.
  bulkDeleteIsPermanent: (mailbox?: { role?: string }) => mailbox?.role === 'trash',
  useEmailStore: selectorStore({
    fetchEmailContent: async () => MESSAGE,
    deleteEmail: async (...args: unknown[]) => {
      calls.deleteArgs.push(args);
      if (calls.fail) throw new Error('server said no');
      calls.order.push('deleted');
      return true;
    },
    moveToMailbox: async () => true,
    markAsRead: async () => true,
    toggleStar: async () => true,
    setEmailKeywordsLocal: () => {},
    mailboxes: [
      { id: 'inbox', role: 'inbox', name: 'Inbox' },
      { id: 'trash', role: 'trash', name: 'Trash' },
    ],
    emails: [],
    selectedEmail: null,
    get selectedMailbox() { return store.selectedMailbox; },
  }),
}));
vi.mock('@/stores/identity-store', () => ({ useIdentityStore: selectorStore({ identities: [] }) }));
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: selectorStore({}) }));
vi.mock('@/stores/pro-tab-store', () => ({ useProTabStore: selectorStore({ openComposeTab: () => {}, closeTab: () => {}, updateTabTitle: () => {} }) }));

import { ProEmailView } from '../pro-email-tab-body';

async function open() {
  const client = { getEmail: vi.fn().mockResolvedValue(MESSAGE), getUsername: () => 'me@example.org', getAccountId: () => 'a' };
  const onClose = vi.fn(() => calls.order.push('closed'));
  render(<ProEmailView emailId="m1" client={client as never} clientAccountId="alice" onClose={onClose} />);
  await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
  return { client, onClose };
}

const deleteNow = () => (viewerProps.current!.onDelete as () => Promise<void>)();

beforeEach(() => {
  viewerProps.current = null;
  calls.order = [];
  calls.offer = [];
  calls.deleteArgs = [];
  calls.fail = false;
  asked.questions = [];
  asked.answer = true;
  toasts.errors = [];
  store.selectedMailbox = 'trash';
  MESSAGE.mailboxIds = { trash: true };
});

describe('Delete forever in a message window from Trash', () => {
  it('asks the permanent question, deletes for good, then closes', async () => {
    await open();
    await deleteNow();
    await waitFor(() => expect(calls.order).toEqual(['deleted', 'offer:delete', 'closed']));
    expect(asked.questions).toHaveLength(1);
    expect(asked.questions[0]).toMatchObject({
      title: 'mail_p3_actions.delete_forever_title',
      confirmText: 'reader_actions.delete_forever',
      variant: 'destructive',
    });
    // forceDelete: the store destroys it instead of moving it to Trash.
    expect(calls.deleteArgs[0][2]).toBe(true);
    // Nothing to undo, so the main window says "Email deleted".
    expect(calls.offer[0][2]).toBeNull();
  });

  it('finds Trash from the message itself when the window browses no folder', async () => {
    store.selectedMailbox = '';
    await open();
    await deleteNow();
    await waitFor(() => expect(calls.order).toEqual(['deleted', 'offer:delete', 'closed']));
    expect(asked.questions).toHaveLength(1);
    expect(calls.deleteArgs[0][2]).toBe(true);
  });

  it('Cancel deletes nothing and keeps the window open', async () => {
    asked.answer = false;
    const { onClose } = await open();
    await deleteNow();
    expect(asked.questions).toHaveLength(1);
    expect(calls.deleteArgs).toHaveLength(0);
    expect(calls.offer).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a refused delete keeps the window open and claims nothing', async () => {
    calls.fail = true;
    const { onClose } = await open();
    await deleteNow();
    await waitFor(() => expect(toasts.errors).toEqual(['notifications.error_deleting']));
    expect(calls.offer).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('outside Trash Delete still moves to Trash without the permanent question', async () => {
    MESSAGE.mailboxIds = { inbox: true };
    store.selectedMailbox = 'inbox';
    await open();
    await deleteNow();
    await waitFor(() => expect(calls.order).toEqual(['deleted', 'offer:delete', 'closed']));
    expect(asked.questions).toHaveLength(0);
    expect(calls.deleteArgs[0][2]).toBe(false);
    expect((calls.offer[0][2] as unknown[]).length).toBe(1);
  });
});
