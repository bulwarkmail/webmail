import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JMAPClient } from '@/lib/jmap/client';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
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

function show(selected: string) {
  const emails = [{ id: 'm1', threadId: 't1', blobId: 'b1', mailboxIds: { [selected]: true }, keywords: {}, subject: 'Hello',
    receivedAt: '2026-10-01T00:00:00Z', from: [{ email: 'someone@example.org' }], size: 1, hasAttachment: false } as Email];
  useEmailStore.setState({
    emails,
    mailboxes: [mailbox('junk', 'Junk', 'junk'), mailbox('trash', 'Deleted Items', 'trash')],
    selectedMailbox: selected,
    totalEmails: 1,
  });
  return render(<EmailList emails={emails} />);
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
