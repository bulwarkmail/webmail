import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageListTabs, listChangeMayAffectCategoryUnread, useMessageListPanelProps } from '../message-list-tabs';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The category strip is a tablist in the user's language whose active tab
// labels the message list, and the arrow keys move between the tabs.

function Harness() {
  const panel = useMessageListPanelProps('panel');
  return (
    <>
      <MessageListTabs panelId="panel" />
      <div {...panel}>list</div>
    </>
  );
}

describe('MessageListTabs', () => {
  beforeEach(() => {
    useMessageListTabsStore.setState({
      tabs: [
        { id: 'primary', label: 'Primary' },
        { id: 'promotions', label: 'Promotions' },
        { id: 'social', label: 'Social' },
      ] as never,
      mailboxRoles: ['inbox'],
      activeTabId: 'primary',
      tabCounts: {},
    });
    useEmailStore.setState({
      mailboxes: [{ id: 'mb-inbox', name: 'Inbox', role: 'inbox' } as Mailbox],
      selectedMailbox: 'mb-inbox',
      selectedKeyword: null,
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      isUnifiedView: false,
      emails: [],
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the strip from the translations and makes the list its panel', () => {
    render(<Harness />);
    const tablist = screen.getByRole('tablist', { name: 'category_tabs' });
    expect(tablist).toBeInTheDocument();
    const active = screen.getByRole('tab', { name: 'Primary' });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(active).toHaveAttribute('aria-controls', 'panel');
    expect(screen.getByRole('tabpanel', { name: 'Primary' })).toHaveTextContent('list');
  });

  it('drops ticked messages on a switch of tab, which lists other mail', () => {
    useEmailStore.setState({ selectedEmailKeys: new Set(['a', 'b']) } as never);
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Primary' }));
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Social' }));
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
  });

  it('keeps one tab stop and moves with the arrow keys', () => {
    render(<Harness />);
    const [primary, promotions, social] = screen.getAllByRole('tab');
    expect(primary).toHaveAttribute('tabindex', '0');
    expect(promotions).toHaveAttribute('tabindex', '-1');
    primary.focus();
    fireEvent.keyDown(primary, { key: 'ArrowRight' });
    expect(promotions).toHaveFocus();
    fireEvent.keyDown(promotions, { key: 'End' });
    expect(social).toHaveFocus();
    fireEvent.keyDown(social, { key: 'ArrowRight' });
    expect(primary).toHaveFocus();
    // Moving the focus doesn't switch the category.
    expect(useMessageListTabsStore.getState().activeTabId).toBe('primary');
  });

  it('leaves the list a plain box when the strip is hidden', () => {
    useEmailStore.setState({ searchQuery: 'invoice' } as never);
    render(<Harness />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  // A tab click fetches the folder again, which threw away the filter search.
  it('stays away during a search that only uses the filters', () => {
    useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob' } } as never);
    render(<Harness />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('refreshes unread chips when a row leaves the list or $seen flips', async () => {
    vi.useFakeTimers();
    const getCategoryUnreadCounts = vi.fn().mockResolvedValue({ primary: 2, promotions: 0, social: 0 });
    useAuthStore.setState({ client: { getCategoryUnreadCounts } } as never);
    const unreadA = { id: 'a', keywords: {} } as Email;
    const unreadB = { id: 'b', keywords: {} } as Email;
    useEmailStore.setState({ emails: [unreadA, unreadB] } as never);

    render(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getCategoryUnreadCounts).toHaveBeenCalledTimes(1);

    // Scroll / load-more: same rows plus another page — no recount.
    act(() => {
      useEmailStore.setState({
        emails: [unreadA, unreadB, { id: 'c', keywords: { $seen: true } } as Email],
      } as never);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(getCategoryUnreadCounts).toHaveBeenCalledTimes(1);

    // Star toggle rebuilds the array without touching $seen — no recount.
    act(() => {
      useEmailStore.setState({
        emails: [
          { ...unreadA, keywords: { $flagged: true } } as Email,
          unreadB,
          { id: 'c', keywords: { $seen: true } } as Email,
        ],
      } as never);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(getCategoryUnreadCounts).toHaveBeenCalledTimes(1);

    // Delete / archive drops a row — recount after debounce.
    act(() => {
      useEmailStore.setState({
        emails: [
          { ...unreadA, keywords: { $flagged: true } } as Email,
          { id: 'c', keywords: { $seen: true } } as Email,
        ],
      } as never);
    });
    expect(getCategoryUnreadCounts).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(getCategoryUnreadCounts).toHaveBeenCalledTimes(2);

    // Mark-read flips $seen — recount.
    act(() => {
      useEmailStore.setState({
        emails: [
          { id: 'a', keywords: { $flagged: true, $seen: true } } as Email,
          { id: 'c', keywords: { $seen: true } } as Email,
        ],
      } as never);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(getCategoryUnreadCounts).toHaveBeenCalledTimes(3);
  });

  it('detects list changes that can move unread tab totals', () => {
    const a = { id: 'a', keywords: {} } as Email;
    const aRead = { id: 'a', keywords: { $seen: true } } as Email;
    const b = { id: 'b', keywords: { $seen: true } } as Email;
    expect(listChangeMayAffectCategoryUnread([a, b], [a, b])).toBe(false);
    expect(listChangeMayAffectCategoryUnread([a, b], [a, b, { id: 'c' } as Email])).toBe(false);
    expect(listChangeMayAffectCategoryUnread([a, b], [{ ...a, keywords: { $flagged: true } } as Email, b])).toBe(false);
    expect(listChangeMayAffectCategoryUnread([a, b], [a])).toBe(true);
    expect(listChangeMayAffectCategoryUnread([a, b], [aRead, b])).toBe(true);
  });
});
