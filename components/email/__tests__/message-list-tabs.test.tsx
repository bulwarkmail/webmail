import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageListTabs, useMessageListPanelProps } from '../message-list-tabs';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useEmailStore } from '@/stores/email-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { Mailbox } from '@/lib/jmap/types';

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
    } as never);
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
});
