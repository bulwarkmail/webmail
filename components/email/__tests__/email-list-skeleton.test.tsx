import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({ client: null, identities: [], username: null, activeAccountId: 'acct-1', getClientForAccount: () => undefined })),
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

const initialEmailState = useEmailStore.getState();

beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox' });
});

describe('email list loading skeleton', () => {
  // An account switch updates the store many times before the first page
  // arrives. A remounted skeleton replays its fade-in, so it flickered.
  it('stays the same element while the list re-renders', () => {
    const view = render(<EmailList emails={[]} isLoading />);
    const skeleton = screen.getByTestId('email-list-skeleton');

    act(() => { useEmailStore.setState({ mailboxes: [], isLoadingMore: false, hasMoreEmails: true }); });
    view.rerender(<EmailList emails={[]} isLoading selectedEmailKey="x" />);

    expect(screen.getByTestId('email-list-skeleton')).toBe(skeleton);
  });
});

describe('email list while another folder loads', () => {
  const emails = ['one', 'two'].map(id => ({ id, threadId: 't-' + id, blobId: 'b-' + id,
    mailboxIds: { inbox: true }, keywords: { $seen: true }, subject: id, receivedAt: '2026-10-01T00:00:00Z',
    from: [{ email: 'someone@example.invalid' }], size: 1, hasAttachment: false } as Email));

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the last rows without a spinner, then shows the skeleton', () => {
    const view = render(<EmailList emails={emails} />);

    act(() => { useEmailStore.setState({ selectedMailbox: 'work' }); });
    view.rerender(<EmailList emails={emails} isLoading />);
    expect(screen.queryByTestId('email-list-loading')).toBeNull();
    expect(screen.queryByTestId('email-list-skeleton')).toBeNull();

    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByTestId('email-list-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('email-list-loading')).toBeNull();

    // The new folder's rows replace the skeleton.
    view.rerender(<EmailList emails={emails} />);
    expect(screen.queryByTestId('email-list-skeleton')).toBeNull();
  });

  it('keeps the overlay for a reload of the open folder', () => {
    const view = render(<EmailList emails={emails} />);

    view.rerender(<EmailList emails={emails} isLoading />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('email-list-loading')).toBeTruthy();
    expect(screen.queryByTestId('email-list-skeleton')).toBeNull();
  });
});
