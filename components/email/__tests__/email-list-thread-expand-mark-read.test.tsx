import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import type { Email } from '@/lib/jmap/types';

/**
 * Expanding a conversation from the list must go through markAsReadDelay:
 * with "Never" nothing is marked read. Guards the list's wiring, not only the
 * store action.
 */

const client = vi.hoisted(() => ({
  getAccountId: () => 'acct-1',
  getThreadEmails: vi.fn(),
  batchMarkAsRead: vi.fn(async () => {}),
}));

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
// jsdom has no layout, so the real virtualizer draws no rows. Draw them all.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 80, size: 80 })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    measure: () => {},
    scrollToOffset: () => {},
    scrollToIndex: () => {},
    measurementsCache: [],
    scrollOffset: 0,
    scrollRect: null,
  }),
}));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({
      client, identities: [], username: null, activeAccountId: 'acct-1',
      getClientForAccount: () => client,
    })),
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

const mail = (id: string, time: string, seen: boolean): Email => ({
  id,
  threadId: 'thread-t',
  mailboxIds: { inbox: true },
  keywords: seen ? { $seen: true } : {},
  size: 1000,
  receivedAt: `2026-09-30T${time}:00Z`,
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Conversation',
  hasAttachment: false,
});

const THREAD = [mail('t2', '16:00', false), mail('t1', '15:00', true)];

const initialEmailState = useEmailStore.getState();
const initialTabsState = useMessageListTabsStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  client.batchMarkAsRead.mockClear();
  client.getThreadEmails.mockResolvedValue(THREAD);
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', emails: THREAD });
  useMessageListTabsStore.setState(initialTabsState, true);
});

afterEach(() => {
  useEmailStore.getState().collapseAllThreads();
  vi.useRealTimers();
});

async function expandFromList() {
  render(<EmailList emails={THREAD} />);
  fireEvent.click(screen.getAllByText('Conversation')[0]);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(useEmailStore.getState().expandedThreadIds.has('thread-t')).toBe(true);
}

describe('email list conversation expansion follows markAsReadDelay', () => {
  it('marks nothing read with "Never" (-1)', async () => {
    useSettingsStore.setState({ markAsReadDelay: -1 });
    await expandFromList();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
  });

  it('marks the unread message read after the delay', async () => {
    useSettingsStore.setState({ markAsReadDelay: 3000 });
    await expandFromList();
    expect(client.batchMarkAsRead).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['t2'], true, undefined);
  });
});
