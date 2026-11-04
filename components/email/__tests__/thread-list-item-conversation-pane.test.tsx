import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import type { Email } from '@/lib/jmap/types';

// With the conversation in the reading pane, the list shows one row per
// conversation: a click opens its newest message there, and the row has no
// chevron to unfold it in the list.

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
  id: 'email-1', threadId: 't', mailboxIds: { inbox: true }, keywords: { $seen: true }, size: 1000,
  receivedAt: '2024-01-15T10:00:00Z', from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Offsite agenda', hasAttachment: false, ...overrides,
});
const conversation = () => groupEmailsByThread([
  makeEmail({ id: 'a', receivedAt: '2024-01-15T09:00:00Z' }),
  makeEmail({ id: 'b', receivedAt: '2024-01-15T10:00:00Z', from: [{ name: 'Bob', email: 'bob@example.com' }] }),
])[0];

function renderRow(conversationInReader: boolean) {
  const onEmailSelect = vi.fn();
  const onToggleExpand = vi.fn();
  const onCollapseAllThreads = vi.fn();
  const thread = conversation();
  render(
    <ThreadListItem
      thread={thread}
      isExpanded={false}
      onToggleExpand={onToggleExpand}
      onCollapseAllThreads={onCollapseAllThreads}
      onEmailSelect={onEmailSelect}
      conversationInReader={conversationInReader}
    />,
  );
  return { onEmailSelect, onToggleExpand, onCollapseAllThreads, thread };
}

beforeEach(() => {
  useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
  useSettingsStore.setState({
    emailKeywords: [...DEFAULT_KEYWORDS], showPreview: true, mailLayout: 'split',
    interfaceLayout: 'default', listColumns: false,
  });
  useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox', isUnifiedView: false });
});

describe('A conversation row with the conversation in the reading pane', () => {
  it('opens the newest message without unfolding the conversation in the list', () => {
    const { onEmailSelect, onToggleExpand, onCollapseAllThreads, thread } = renderRow(true);
    fireEvent.click(screen.getByRole('row'));
    expect(onEmailSelect).toHaveBeenCalledWith(thread.latestEmail);
    expect(onToggleExpand).not.toHaveBeenCalled();
    expect(onCollapseAllThreads).not.toHaveBeenCalled();
  });

  it('has no chevron and does not claim to unfold', () => {
    renderRow(true);
    expect(screen.queryByRole('button', { name: /expand_named/ })).toBeNull();
    expect(screen.getByRole('row')).not.toHaveAttribute('aria-expanded');
  });

  it('has no chevron in the columns layout either', () => {
    useSettingsStore.setState({ mailLayout: 'horizontal', listColumns: true });
    renderRow(true);
    expect(screen.queryByRole('button', { name: /expand_named/ })).toBeNull();
  });

  it('still ticks the whole conversation with Ctrl+click', () => {
    const { onEmailSelect } = renderRow(true);
    fireEvent.click(screen.getByRole('row'), { ctrlKey: true });
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(2);
    expect(onEmailSelect).not.toHaveBeenCalled();
  });

  it('unfolds in the list when the reading pane shows one message', () => {
    const { onToggleExpand } = renderRow(false);
    expect(screen.getByRole('button', { name: /expand_named/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('row'));
    expect(onToggleExpand).toHaveBeenCalled();
  });
});
