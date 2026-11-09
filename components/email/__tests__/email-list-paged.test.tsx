import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email } from '@/lib/jmap/types';

// SR-21: simple mode can show the list in pages of 50 with Previous and Next.

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

const MAILS: Email[] = Array.from({ length: 120 }, (_, i) => ({
  id: `m${i}`,
  threadId: `t${i}`,
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: new Date(Date.UTC(2026, 8, 30, 12, 0) - i * 60_000).toISOString(),
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: `Mail ${i}`,
  hasAttachment: false,
}));

const initialEmailState = useEmailStore.getState();

beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', emails: MAILS, hasMoreEmails: false });
  useSettingsStore.setState({ simpleMode: true, simpleModePagedList: true, disableThreading: true } as never);
});

describe('paged message list (SR-21)', () => {
  it('shows 50 rows at a time and pages with Next and Previous', () => {
    render(<EmailList emails={MAILS} />);
    expect(screen.getAllByRole('row')).toHaveLength(50);
    expect(screen.getByRole('row', { name: /Mail 0,/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'pages.next' }));
    expect(screen.getByRole('row', { name: /Mail 50,/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /Mail 0,/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'pages.next' }));
    expect(screen.getAllByRole('row')).toHaveLength(20);
    expect(screen.getByRole('button', { name: 'pages.next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'pages.previous' }));
    expect(screen.getByRole('row', { name: /Mail 50,/ })).toBeTruthy();
  });

  it('tells each row its place in the whole list', () => {
    render(<EmailList emails={MAILS} />);
    fireEvent.click(screen.getByRole('button', { name: 'pages.next' }));
    expect(screen.getByRole('row', { name: /Mail 50,/ })).toHaveAttribute('aria-posinset', '51');
    expect(screen.getByRole('row', { name: /Mail 50,/ })).toHaveAttribute('aria-setsize', '120');
  });

  it('scrolls endlessly as before without the paged option', () => {
    useSettingsStore.setState({ simpleModePagedList: false } as never);
    render(<EmailList emails={MAILS} />);
    expect(screen.queryByRole('button', { name: 'pages.next' })).toBeNull();
  });
});
