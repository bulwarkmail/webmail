import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import type { Email } from '@/lib/jmap/types';

// #1230: shift-click ranges walk the list's rows as drawn. The list hands
// them to the store; check it hands over the screen order, with a thread as
// one row holding all its messages.

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({ client: null, identities: [], username: null, activeAccountId: 'acct-1' })),
  };
});
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  return {
    useAccountStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const mail = (id: string, time: string, threadId = `thread-${id}`): Email => ({
  id,
  threadId,
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: `2026-09-30T${time}:00Z`,
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});

// The issue's inbox, in the flat date order the server returns.
const INBOX = [
  mail('t3', '17:00', 'thread-t'),
  mail('A', '16:45'),
  mail('B', '16:00'),
  mail('C', '15:15'),
  mail('t2', '15:00', 'thread-t'),
  mail('D', '14:30'),
  mail('t1', '13:00', 'thread-t'),
];

const initialEmailState = useEmailStore.getState();
const initialTabsState = useMessageListTabsStore.getState();

beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', emails: INBOX });
  useMessageListTabsStore.setState(initialTabsState, true);
});

describe('email list rows for shift-click ranges (#1230)', () => {
  it('hands the store its rows in screen order, a thread as one row', () => {
    render(<EmailList emails={INBOX} />);
    expect(useEmailStore.getState().listRows).toEqual([
      { key: 't3', members: ['t3', 't2', 't1'] },
      { key: 'A', members: ['A'] },
      { key: 'B', members: ['B'] },
      { key: 'C', members: ['C'] },
      { key: 'D', members: ['D'] },
    ]);
  });

  it('keeps a thread out of a range its row is not in', () => {
    render(<EmailList emails={INBOX} />);
    act(() => {
      useEmailStore.getState().toggleEmailSelection({ id: 'D' });
      useEmailStore.getState().selectRangeEmails({ id: 'B' });
    });
    expect([...useEmailStore.getState().selectedEmailKeys].sort()).toEqual(['B', 'C', 'D']);
  });

  it('adds an expanded thread\'s messages as rows under it', () => {
    useEmailStore.setState({ expandedThreadIds: new Set(['thread-t']) });
    render(<EmailList emails={INBOX} />);
    expect(useEmailStore.getState().listRows?.slice(0, 4).map((r) => r.key)).toEqual(['t3', 't3', 't2', 't1']);
  });

  it('withdraws its rows when it goes away', () => {
    const view = render(<EmailList emails={INBOX} />);
    view.unmount();
    expect(useEmailStore.getState().listRows).toBeNull();
  });
});
