import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

/**
 * mail-4: Archive or Delete in a message window closed the window, its toast
 * went with it, and nothing could undo the move. The view now hands the
 * restore points to offerMoveUndo (lib/popout/moved-undo), which gives them
 * to the main window, before the window closes.
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
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key, useLocale: () => 'en' }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: () => {}, success: () => {} } }));
vi.mock('@/lib/mail-removal-confirm', () => ({ confirmMailRemoval: async () => true }));
// A delete for good asks first (mail-p3-1); here the answer is yes.
vi.mock('@/hooks/use-confirm-dialog', () => ({ useConfirmDialog: () => ({ dialogProps: {}, confirm: async () => true }) }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));

const calls = vi.hoisted(() => ({ order: [] as string[], offer: [] as unknown[][] }));
vi.mock('@/lib/popout/moved-undo', () => ({
  offerMoveUndo: async (...args: unknown[]) => {
    calls.order.push(`offer:${args[0]}`);
    calls.offer.push(args);
  },
}));
const role = vi.hoisted(() => ({ popout: true }));
vi.mock('@/lib/popout/window-role', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/popout/window-role')>(),
  isPopoutWindow: () => role.popout,
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
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ email: 'sam@example.org', name: 'Sam' }],
  to: [{ email: 'me@example.org' }],
  subject: 'Launch day!',
  bodyValues: { '1': { value: 'Hi' } },
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [{ partId: '1', type: 'text/plain' }],
  attachments: [],
}));
const permanent = vi.hoisted(() => ({ value: false }));
vi.mock('@/stores/email-store', () => ({
  resolveEmailBlobContext: (_email: unknown, client: unknown) => ({ client }),
  restoreBatchesFor: (emails: Array<{ id: string; mailboxIds: Record<string, boolean> }>, client: unknown) =>
    [{ client, points: emails.map((e) => ({ id: e.id, mailboxIds: e.mailboxIds, seen: true })) }],
  bulkDeleteIsPermanent: () => permanent.value,
  useEmailStore: selectorStore({
    fetchEmailContent: async () => MESSAGE,
    deleteEmail: async () => { calls.order.push('deleted'); return true; },
    moveToMailbox: async () => { calls.order.push('moved'); return true; },
    markAsRead: async () => true,
    toggleStar: async () => true,
    setEmailKeywordsLocal: () => {},
    mailboxes: [{ id: 'inbox', role: 'inbox', name: 'Inbox' }, { id: 'archive', role: 'archive', name: 'Archive' }],
    emails: [],
    selectedEmail: null,
    selectedMailbox: 'inbox',
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

beforeEach(() => {
  viewerProps.current = null;
  calls.order = [];
  calls.offer = [];
  role.popout = true;
  permanent.value = false;
});

describe('a move out of a message window', () => {
  it('Archive hands its Undo on before the window closes', async () => {
    const { client } = await open();
    await (viewerProps.current!.onArchive as () => Promise<void>)();
    await waitFor(() => expect(calls.order).toEqual(['moved', 'offer:archive', 'closed']));
    const [, offeredClient, restore, , inOwnWindow] = calls.offer[0];
    expect(offeredClient).toBe(client);
    expect(restore).toEqual([{ client, points: [{ id: 'm1', mailboxIds: { inbox: true }, seen: true }] }]);
    expect(inOwnWindow).toBe(true);
  });

  it('Delete does too', async () => {
    await open();
    await (viewerProps.current!.onDelete as () => Promise<void>)();
    await waitFor(() => expect(calls.order).toEqual(['deleted', 'offer:delete', 'closed']));
    expect((calls.offer[0][2] as unknown[]).length).toBe(1);
  });

  it('a delete for good has nothing to undo', async () => {
    permanent.value = true;
    await open();
    await (viewerProps.current!.onDelete as () => Promise<void>)();
    await waitFor(() => expect(calls.order).toEqual(['deleted', 'offer:delete', 'closed']));
    expect(calls.offer[0][2]).toBeNull();
  });

  it('Move to a folder does too', async () => {
    await open();
    await (viewerProps.current!.onMoveToMailbox as (id: string) => Promise<void>)('archive');
    await waitFor(() => expect(calls.order).toEqual(['moved', 'offer:move', 'closed']));
  });

  it('in a tab of the main window the Undo stays in this window', async () => {
    role.popout = false;
    await open();
    await (viewerProps.current!.onArchive as () => Promise<void>)();
    await waitFor(() => expect(calls.offer).toHaveLength(1));
    expect(calls.offer[0][4]).toBe(false);
  });
});
