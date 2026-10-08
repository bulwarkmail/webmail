import { act, render } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
// The avatar resolves app config and favicons; neither matters here.
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

const makeEmail = (id: string): Email => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2026-09-30T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});

const INBOX = [makeEmail('a'), makeEmail('b')];

// jsdom has no layout and no Element.scrollTo, which the list's virtualizer
// scrolls with. Record the calls: a reset is a scroll to the top.
const scrollTo = vi.fn();
const element = HTMLElement.prototype as unknown as Record<string, unknown>;
beforeAll(() => { element.scrollTo = scrollTo; });
afterAll(() => { delete element.scrollTo; });

const initialEmailState = useEmailStore.getState();
const initialTabsState = useMessageListTabsStore.getState();

beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox' });
  useMessageListTabsStore.setState(initialTabsState, true);
  useAuthStore.setState({ activeAccountId: 'acct-1' });
});

/** The list, scrolled down by the user. */
function renderScrolledList() {
  const view = render(<EmailList emails={INBOX} />);
  const scroller = view.container.querySelector('[data-tour="email-list"]') as HTMLElement;
  scroller.scrollTop = 800;
  scrollTo.mockClear();
  return view;
}

const resetToTop = () => scrollTo.mock.calls.some(([options]) => options?.top === 0);

describe('email list scroll position', () => {
  it.each([
    ['another folder', () => useEmailStore.getState().selectMailbox('archive')],
    ['a folder of another account', () => useEmailStore.getState().selectAccountMailbox('acct-2', 'inbox')],
    ['a tag', () => useEmailStore.getState().selectKeyword('$label1')],
    ['a unified view', () => useEmailStore.setState({ isUnifiedView: true, unifiedRole: 'inbox' })],
    ['a cross-account view', () => useEmailStore.setState({ isUnifiedView: true, crossView: 'unread' })],
    ['another account', () => useAuthStore.setState({ activeAccountId: 'acct-2' })],
    ['a plugin tab', () => useMessageListTabsStore.setState({ activeTabId: 'newsletters' })],
    ['a search', () => useEmailStore.getState().setSearchQuery('invoice')],
    ['a search filter', () => useEmailStore.setState({ searchFilters: { ...useEmailStore.getState().searchFilters, from: 'alice@example.com' } })],
    // What a click on a folder's unread count does.
    ['the unread mail of a folder', () => {
      useEmailStore.getState().scopeSearchToOpenFolder();
      useEmailStore.getState().setSearchFilters({ isUnread: true });
    }],
  ])('opens %s at the top', (_view, switchView) => {
    renderScrolledList();
    act(() => { switchView(); });
    expect(resetToTop()).toBe(true);
  });

  it('opens the scheduled messages at the top', () => {
    const view = renderScrolledList();
    view.rerender(<EmailList emails={INBOX} isScheduledView />);
    expect(resetToTop()).toBe(true);
  });

  it('starts over when the scope of a running search changes', () => {
    useEmailStore.getState().setSearchQuery('invoice');
    renderScrolledList();
    act(() => { useEmailStore.setState({ searchMailboxId: 'archive' }); });
    expect(resetToTop()).toBe(true);
  });

  it('ends on the mail a link opens along with its folder', () => {
    // A layout for the virtualizer: a 300px list of 60px rows. jsdom has
    // none, and without one every scroll target clamps to 0.
    const mails = Array.from({ length: 30 }, (_, i) => makeEmail(`m${i}`));
    const isList = (el: Element) => (el as HTMLElement).dataset?.tour === 'email-list';
    const stubs = [
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return isList(this) ? 300 : 0; }),
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300),
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return isList(this) ? mails.length * 60 : 0; }),
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return isList(this) ? 300 : 0; }),
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const height = this.hasAttribute('data-index') ? 60 : 0;
        return { x: 0, y: 0, width: 300, height, top: 0, left: 0, right: 300, bottom: height, toJSON: () => ({}) } as DOMRect;
      }),
    ];
    try {
      const view = render(<EmailList emails={mails} />);
      scrollTo.mockClear();
      act(() => {
        useEmailStore.getState().selectMailbox('archive');
        view.rerender(<EmailList emails={mails} selectedEmailId="m20" />);
      });
      // The reset comes first and the scroll down to the selected mail after
      // it - the other way round, the reset would leave the mail out of view.
      const tops = scrollTo.mock.calls.map(([options]) => options?.top);
      expect(tops).toContain(0);
      expect(tops.lastIndexOf(0)).toBeLessThan(tops.length - 1);
      expect(tops[tops.length - 1]).toBeGreaterThan(0);
    } finally {
      stubs.forEach((stub) => stub.mockRestore());
    }
  });

  it('keeps the position through new mail, loading more and a refresh', () => {
    const view = renderScrolledList();
    view.rerender(<EmailList emails={[makeEmail('new'), ...INBOX]} />);
    view.rerender(<EmailList emails={[makeEmail('new'), ...INBOX, makeEmail('older')]} isLoading />);
    view.rerender(<EmailList emails={[makeEmail('new'), ...INBOX, makeEmail('older')]} />);
    expect(resetToTop()).toBe(false);
  });

  it('keeps the position when a unified view refetches in place (as after "not spam")', () => {
    useEmailStore.setState({ isUnifiedView: true, unifiedRole: 'junk' });
    const view = renderScrolledList();
    // The store's own view counter moves on such a refetch; the view does not.
    act(() => { useEmailStore.setState((state) => ({ viewToken: state.viewToken + 1, isUnifiedView: true, unifiedRole: 'junk' })); });
    view.rerender(<EmailList emails={[INBOX[1]]} />);
    expect(resetToTop()).toBe(false);
  });

  it('keeps the position when only the search scope is picked, with no search running', () => {
    renderScrolledList();
    act(() => { useEmailStore.setState({ searchMailboxId: 'archive' }); });
    expect(resetToTop()).toBe(false);
  });
});
