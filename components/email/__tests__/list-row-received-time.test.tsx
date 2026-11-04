import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { formatDate } from '@/lib/utils';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null, client: null, activeAccountId: null, getClientForAccount: () => undefined };
  const useAuthStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state },
  );
  return { useAuthStore };
});

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  threadId: 'thread-1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Test Subject',
  hasAttachment: false,
  ...overrides,
});

function renderRow(emails: Email[]) {
  const [thread] = groupEmailsByThread(emails);
  return render(
    <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />,
  );
}

beforeEach(() => {
  useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
  useSettingsStore.setState({
    emailKeywords: [...DEFAULT_KEYWORDS],
    showPreview: false,
    mailLayout: 'split',
    interfaceLayout: 'default',
    timeZone: 'UTC',
  });
  useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox' });
});

// The list sorts by arrival, so its rows show when the mail arrived (mail-17).
describe('list row time', () => {
  it('shows when a delayed mail arrived, not its Date header', () => {
    const sentAt = '2024-01-13T08:00:00Z';
    const receivedAt = '2024-01-15T10:00:00Z';
    renderRow([makeEmail({ sentAt, receivedAt })]);

    expect(screen.getByText(formatDate(receivedAt))).toBeInTheDocument();
    expect(screen.queryByText(formatDate(sentAt))).not.toBeInTheDocument();
  });

  it('shows when the newest message of a conversation arrived', () => {
    renderRow([
      makeEmail({ id: 'a', sentAt: '2024-01-10T08:00:00Z', receivedAt: '2024-01-10T08:01:00Z' }),
      makeEmail({ id: 'b', sentAt: '2024-01-13T08:00:00Z', receivedAt: '2024-01-15T10:00:00Z' }),
    ]);

    expect(screen.getByText(formatDate('2024-01-15T10:00:00Z'))).toBeInTheDocument();
    expect(screen.queryByText(formatDate('2024-01-13T08:00:00Z'))).not.toBeInTheDocument();
  });

  it('keeps the Date header for imported mail that arrived long after it was sent (#891)', () => {
    const sentAt = '2019-03-04T05:06:07Z';
    const receivedAt = '2024-01-15T10:00:00Z';
    renderRow([makeEmail({ sentAt, receivedAt })]);

    expect(screen.getByText(formatDate(sentAt))).toBeInTheDocument();
  });
});
