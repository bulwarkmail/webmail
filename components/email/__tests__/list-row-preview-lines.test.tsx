import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
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

const PREVIEW = 'Hi Robin, thanks for the quick reply. I went through the points again.';

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  threadId: 'thread-1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Test Subject',
  preview: PREVIEW,
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
  useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
  useSettingsStore.setState({
    emailKeywords: [...DEFAULT_KEYWORDS],
    showPreview: true,
    mailLayout: 'split',
    interfaceLayout: 'default',
  });
  useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox' });
});

// mail-15: the default density puts the preview after the subject, on the
// subject's line, so about ten rows fit at 1366×768 (they were about 96 px,
// seven on screen); comfortable keeps two preview lines, and a phone keeps
// the preview under the subject.
describe('list row preview lines', () => {
  const onSubjectLine = () => {
    const preview = screen.getByText(PREVIEW, { exact: false });
    return preview.closest('[data-row-preview]') !== null;
  };

  it.each([
    ['message', [makeEmail()]],
    ['conversation', [makeEmail({ id: 'a' }), makeEmail({ id: 'b', receivedAt: '2024-01-16T10:00:00Z' })]],
  ] as const)('a regular %s row shows its preview on the subject line', (_kind, emails) => {
    useSettingsStore.setState({ density: 'regular' });
    renderRow([...emails]);
    expect(onSubjectLine()).toBe(true);
    expect(document.querySelector('p.line-clamp-1')).toBeNull();
  });

  it('a comfortable row keeps two preview lines of its own', () => {
    useSettingsStore.setState({ density: 'comfortable' });
    renderRow([makeEmail()]);
    expect(onSubjectLine()).toBe(false);
    expect(screen.getByText(PREVIEW).className.split(/\s+/)).toContain('line-clamp-2');
  });

  it('a regular row on a phone keeps the preview under the subject', () => {
    useUIStore.setState({ isMobile: true });
    useSettingsStore.setState({ density: 'regular' });
    renderRow([makeEmail()]);
    expect(onSubjectLine()).toBe(false);
    expect(screen.getByText(PREVIEW).className.split(/\s+/)).toContain('line-clamp-1');
  });
});
