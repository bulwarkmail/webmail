import { Profiler } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { TagDisplayContext, type TagDisplay } from '@/hooks/use-tag-display';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { SEARCH_SCOPE_ALL_FOLDERS } from '@/lib/search-scope-folders';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null };
  return {
    useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

const accountState = { accounts: [], getAccountById: () => undefined };
vi.mock('@/stores/account-store', () => ({
  useAccountStore: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (selector: any) => (selector ? selector(accountState) : accountState),
    { getState: () => accountState },
  ),
}));

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  threadId: 'thread-1',
  mailboxIds: { archive: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Invoice',
  hasAttachment: false,
  // Stamped by the all-folders search fan-out (searchAcrossAccounts).
  sourceFolder: 'Archive',
  ...overrides,
});

function renderThread(emails: Email[]) {
  const [thread] = groupEmailsByThread(emails);
  return render(
    <ThreadListItem
      thread={thread}
      isExpanded={false}
      onToggleExpand={() => {}}
      onEmailSelect={() => {}}
    />,
  );
}

const noop = () => {};
const single = () => [makeEmail()];
const conversation = () => [
  makeEmail({ id: 'email-1', receivedAt: '2024-01-15T10:00:00Z' }),
  makeEmail({ id: 'email-2', receivedAt: '2024-01-16T10:00:00Z' }),
];

describe('ThreadListItem folder chip in search results (#1172)', () => {
  beforeEach(() => {
    useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set<string>(),
      selectedMailbox: 'inbox',
      isUnifiedView: false,
      selectedKeyword: null,
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      searchMailboxId: '',
    });
  });

  describe.each([
    ['single message', single],
    ['conversation', conversation],
  ])('%s row', (_label, emails) => {
    it('shows the folder when the search covers all folders except Spam and Trash', () => {
      useEmailStore.setState({ searchQuery: 'invoice', searchMailboxId: '' });
      renderThread(emails());
      expect(screen.getByTitle('Archive')).toBeTruthy();
    });

    it('shows the folder when the search covers all folders', () => {
      useEmailStore.setState({ searchQuery: 'invoice', searchMailboxId: SEARCH_SCOPE_ALL_FOLDERS });
      renderThread(emails());
      expect(screen.getByTitle('Archive')).toBeTruthy();
    });

    it('shows the folder when only advanced filters drive the search', () => {
      useEmailStore.setState({
        searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'alice' },
        searchMailboxId: '',
      });
      renderThread(emails());
      expect(screen.getByTitle('Archive')).toBeTruthy();
    });

    it('hides the folder when the search is scoped to one folder', () => {
      useEmailStore.setState({ searchQuery: 'invoice', searchMailboxId: 'archive' });
      renderThread(emails());
      expect(screen.queryByTitle('Archive')).toBeNull();
    });

    it('hides the folder outside a search', () => {
      renderThread(emails());
      expect(screen.queryByTitle('Archive')).toBeNull();
    });

    it('still shows the folder in the unified view', () => {
      useEmailStore.setState({ isUnifiedView: true });
      renderThread(emails());
      expect(screen.getByTitle('Archive')).toBeTruthy();
    });

    it('does not re-render a row without a folder when a search starts', () => {
      // The folder's own list stays on screen until the results arrive; its
      // rows carry no sourceFolder and have no chip to show.
      const [thread] = groupEmailsByThread(emails().map((e) => ({ ...e, sourceFolder: undefined })));
      const onRender = vi.fn();
      render(
        <Profiler id="row" onRender={onRender}>
          <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={noop} onEmailSelect={noop} />
        </Profiler>,
      );
      onRender.mockClear();
      act(() => useEmailStore.setState({ searchQuery: 'invoice', searchMailboxId: '' }));
      expect(onRender).not.toHaveBeenCalled();
    });
  });
});

describe('ThreadListItem sender line in a narrow list', () => {
  const display: TagDisplay = { variant: 'badge', placement: 'sender', tight: true };
  const tagged = (keywords: Record<string, boolean>) => [makeEmail({ keywords: { $seen: true, ...keywords } })];
  const renderIn = (value: TagDisplay, emails: Email[]) => {
    const [thread] = groupEmailsByThread(emails);
    return render(
      <TagDisplayContext.Provider value={value}>
        <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={noop} onEmailSelect={noop} />
      </TagDisplayContext.Provider>,
    );
  };

  beforeEach(() => {
    useUIStore.setState({ isMobile: true, isTablet: false, isDesktop: false });
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], showPreview: false, mailLayout: 'split', interfaceLayout: 'default', showColorNames: false });
    useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox', isUnifiedView: false, selectedKeyword: null, searchQuery: '', searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: 'archive' });
  });

  const dots = (c: HTMLElement) => c.querySelectorAll('[data-tag-dot]').length;

  it('names a single tag', () => {
    const { container } = renderIn(display, tagged({ '$label:red': true }));
    expect(dots(container)).toBe(0);
  });

  it('turns several tags into dots so the name keeps its room', () => {
    const { container } = renderIn(display, tagged({ '$label:red': true, '$label:blue': true }));
    expect(dots(container)).toBe(2);
  });

  it('turns a tag into a dot next to the folder chip', () => {
    useEmailStore.setState({ searchQuery: 'invoice', searchMailboxId: '' });
    const { container } = renderIn(display, tagged({ '$label:red': true }));
    expect(dots(container)).toBe(1);
  });

  it('keeps the names while the list has room', () => {
    const { container } = renderIn({ ...display, tight: false }, tagged({ '$label:red': true, '$label:blue': true }));
    expect(dots(container)).toBe(0);
  });
});
