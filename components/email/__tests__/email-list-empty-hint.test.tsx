import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JMAPClient } from '@/lib/jmap/client';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useToastStore } from '@/stores/toast-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { EmailList } from '../email-list';

// Usability test 2026-11-04, mail-14: the Spam folder's banner said "empty the
// Junk folder", the server's name, while the sidebar calls it Spam.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date | string) => String(d),
    relativeTime: (d: Date | string) => String(d),
    number: (n: number) => String(n),
  }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ stalwartFeaturesEnabled: false, isLoading: false }) }));

const initialEmail = useEmailStore.getState();
const initialAuth = useAuthStore.getState();

function mailbox(id: string, name: string, role: string): Mailbox {
  return { id, name, role, accountId: 'c', totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true } } as Mailbox;
}

function LiveEmailList() {
  const emails = useEmailStore(state => state.emails);
  return <EmailList emails={emails} />;
}

function show(selected: string, withRefusedMessage = false) {
  const emails = [{ id: 'm1', threadId: 't1', blobId: 'b1', mailboxIds: { [selected]: true }, keywords: {}, subject: 'Hello',
    receivedAt: '2026-10-01T00:00:00Z', from: [{ email: 'someone@example.org' }], size: 1, hasAttachment: false } as Email];
  const refused = withRefusedMessage
    ? { ...emails[0], id: 'kept', threadId: 'kept', subject: 'Kept message', keywords: { $seen: true } }
    : null;
  if (refused) emails.push(refused);
  const trash = mailbox('trash', 'Deleted Items', 'trash');
  if (refused) Object.assign(trash, { totalEmails: 2, unreadEmails: 1, totalThreads: 2, unreadThreads: 1 });
  useEmailStore.setState({
    emails,
    selectedEmail: refused,
    mailboxes: [mailbox('junk', 'Junk', 'junk'), trash],
    selectedMailbox: selected,
    totalEmails: emails.length,
  });
  render(<LiveEmailList />);
  return trash;
}

beforeEach(() => {
  const client = JMAPClient.withBearer('https://list.example.invalid', 'synthetic', 'someone@example.org');
  Object.assign(client, { apiUrl: 'https://list.example.invalid/jmap', accountId: 'c' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ methodResponses: [] }))));
  useAuthStore.setState({ activeAccountId: 'acc', client, getClientForAccount: () => client } as never);
  useEmailStore.setState(initialEmail, true);
});

afterEach(() => {
  useAuthStore.setState(initialAuth, true);
  vi.unstubAllGlobals();
});

describe('EmailList empty-folder banner', () => {
  it('names Spam as the sidebar does', () => {
    show('junk');
    expect(screen.getByText('empty_hint {"folder":"mailboxes.spam"}')).toBeTruthy();
    expect(screen.queryByText(/Junk/)).toBeNull();
  });

  it('names Trash as the sidebar does', () => {
    show('trash');
    expect(screen.getByText('empty_hint {"folder":"mailboxes.trash"}')).toBeTruthy();
  });
});

// mail-p3-5: the banner's button said "Empty folder" while the folder menu
// said "Empty Trash"; now both say "Empty Trash" / "Empty Spam".
describe('EmailList empty-folder button', () => {
  it('says Empty Trash in Trash', () => {
    show('trash');
    expect(screen.getByRole('button', { name: 'mail_p2_folders.empty_trash' })).toBeTruthy();
    expect(screen.queryByText('empty_folder.button')).toBeNull();
  });

  it('says Empty Spam in Spam', () => {
    show('junk');
    expect(screen.getByRole('button', { name: 'mail_p2_folders.empty_spam' })).toBeTruthy();
  });
});

it('reports a partially refused Empty Trash and lets the user retry the remaining mail', async () => {
  const trash = show('trash', true);
  const remaining = new Set(['m1', 'kept']);
  const destroy = vi.fn(() => {
    const ids = [...remaining];
    const accepted = remaining.has('m1') ? ['m1'] : ids;
    accepted.forEach(id => remaining.delete(id));
    return [
      ['Email/query', { ids }, '0'],
      ['Email/set', { destroyed: accepted, notDestroyed: remaining.size ? { kept: { type: 'forbidden' } } : null }, '1'],
    ];
  });
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const { methodCalls } = JSON.parse(String(init?.body));
    return Response.json({ methodResponses: methodCalls[0][0] === 'Email/query' ? destroy() : [
      ['Mailbox/get', { list: [{ ...trash, totalEmails: remaining.size, unreadEmails: 0, totalThreads: remaining.size, unreadThreads: 0 }] }, '0'],
    ] });
  });

  const emptyTrash = 'mail_p2_folders.empty_trash';
  const confirm = () => {
    fireEvent.click(screen.getByRole('button', { name: emptyTrash }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: emptyTrash }));
  };
  useToastStore.getState().clearToasts();
  try {
    confirm();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useEmailStore.getState().isLoading).toBe(false));
    expect([...remaining]).toEqual(['kept']);
    expect(useEmailStore.getState().emails.map(email => email.id)).toEqual(['kept']);
    expect(useEmailStore.getState().selectedEmail?.id).toBe('kept');
    expect(useEmailStore.getState().mailboxes[1]).toMatchObject({ totalEmails: 1, unreadEmails: 0 });
    expect(useToastStore.getState().toasts).toMatchObject([{ type: 'error', title: 'mailbox_context_menu.toast_error_empty' }]);

    await waitFor(() => expect(screen.getByRole('button', { name: emptyTrash })).toBeEnabled());
    confirm();
    await waitFor(() => expect(useEmailStore.getState().emails).toEqual([]));
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(remaining.size).toBe(0);
  } finally {
    useToastStore.getState().clearToasts();
  }
});
