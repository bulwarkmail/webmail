import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';

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
  const state = { getAccountById: () => undefined };
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
