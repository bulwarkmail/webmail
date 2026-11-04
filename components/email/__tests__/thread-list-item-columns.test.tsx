import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { ListColumnsHeader } from '../list-columns';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
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

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  threadId: 'thread-1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 2048,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Test Subject',
  preview: 'Preview text',
  hasAttachment: false,
  ...overrides,
});

const conversation = () => [
  makeEmail({ id: 'm1', size: 1024, receivedAt: '2024-01-14T10:00:00Z', from: [{ name: 'Alice', email: 'alice@example.com' }] }),
  makeEmail({ id: 'm2', size: 3072, receivedAt: '2024-01-15T10:00:00Z', from: [{ name: 'Bob', email: 'bob@example.com' }] }),
];

function renderEmails(emails: Email[], isExpanded = false) {
  const [thread] = groupEmailsByThread(emails);
  return render(
    <ThreadListItem
      thread={thread}
      isExpanded={isExpanded}
      expandedEmails={isExpanded ? thread.emails : undefined}
      onToggleExpand={() => {}}
      onEmailSelect={() => {}}
    />,
  );
}

const sizeCells = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-list-size]')).map((el) => el.textContent);

describe('message list rows under the bottom reading pane (#262)', () => {
  beforeEach(() => {
    useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: true,
      mailLayout: 'horizontal',
      interfaceLayout: 'default',
      density: 'regular',
      listColumns: false,
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set<string>(),
      selectedMailbox: 'inbox',
      isUnifiedView: false,
    });
  });

  it('draws a message on one line', () => {
    const { container } = renderEmails([makeEmail()]);
    // Stacked rows give the preview a paragraph of its own.
    expect(container.querySelector('p')).toBeNull();
    expect(screen.getByText(/Preview text/)).toBeInTheDocument();
  });

  it('draws one line on a compact desktop too, which shows the bottom pane', () => {
    useUIStore.setState({ isMobile: false, isCompact: true, isDesktop: true });
    const { container } = renderEmails([makeEmail()]);
    expect(container.querySelector('p')).toBeNull();
  });

  it('keeps stacked rows on a phone', () => {
    useUIStore.setState({ isMobile: true, isCompact: false, isDesktop: false });
    const { container } = renderEmails([makeEmail()]);
    expect(container.querySelector('p')).not.toBeNull();
  });

  it('keeps stacked rows in the split layout', () => {
    useSettingsStore.setState({ mailLayout: 'split' });
    const { container } = renderEmails([makeEmail()]);
    // Stacked: a preview line of its own, or the preview after the subject
    // on the subject's line at the regular density (mail-15).
    expect(container.querySelector('p, [data-row-preview]')).not.toBeNull();
  });

  describe('as columns', () => {
    beforeEach(() => {
      useSettingsStore.setState({ listColumns: true });
    });

    it('is off by default', () => {
      expect(useSettingsStore.getInitialState().listColumns).toBe(false);
    });

    it('shows the size of a message', () => {
      const { container } = renderEmails([makeEmail()]);
      expect(sizeCells(container)).toEqual(['2 KB']);
    });

    it('shows a folded conversation as one row with names, count and total size', () => {
      const { container } = renderEmails(conversation());
      const from = container.querySelector('[data-list-from]') as HTMLElement;
      expect(from).not.toBeNull();
      expect(from.textContent).toContain('Alice');
      expect(from.textContent).toContain('Bob');
      expect(within(from).getByText('(2)')).toBeInTheDocument();
      expect(sizeCells(container)).toEqual(['4 KB']);
      expect(screen.queryAllByTestId('thread-email-row')).toHaveLength(0);
    });

    it('lists each message of an unfolded conversation under it with its own sender and size', () => {
      const { container } = renderEmails(conversation(), true);
      const rows = screen.getAllByTestId('thread-email-row');
      expect(rows).toHaveLength(2);
      const senders = rows.map((row) => row.textContent);
      expect(senders.some((s) => s?.includes('Alice') && !s.includes('Bob'))).toBe(true);
      expect(senders.some((s) => s?.includes('Bob') && !s.includes('Alice'))).toBe(true);
      expect(sizeCells(container).sort()).toEqual(['1 KB', '3 KB', '4 KB']);
    });

    it('leaves the split layout alone', () => {
      useSettingsStore.setState({ mailLayout: 'split' });
      const { container } = renderEmails([makeEmail()]);
      expect(sizeCells(container)).toEqual([]);
    });

    it('leaves Mountain View rows alone', () => {
      useSettingsStore.setState({ interfaceLayout: 'mountain-view' });
      const { container } = renderEmails([makeEmail()]);
      expect(sizeCells(container)).toEqual([]);
    });

    it('also applies to the focused list', () => {
      useSettingsStore.setState({ mailLayout: 'focus' });
      const { container } = renderEmails([makeEmail()]);
      expect(sizeCells(container)).toEqual(['2 KB']);
    });
  });
});

describe('ListColumnsHeader', () => {
  it('titles the columns', () => {
    render(<ListColumnsHeader density="regular" selecting={false} showRecipient={false} />);
    const header = screen.getByTestId('list-columns-header');
    expect(header.textContent).toBe('fromsubjectdatesize');
  });

  it('heads the first column with the recipient in Sent and Drafts', () => {
    render(<ListColumnsHeader density="regular" selecting={false} showRecipient />);
    expect(screen.getByTestId('list-columns-header').textContent).toBe('tosubjectdatesize');
  });
});
