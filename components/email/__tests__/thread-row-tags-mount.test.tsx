import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { ThreadEmailItem } from '../thread-email-item';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import { useEmailStore } from '@/stores/email-store';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null, client: null, activeAccountId: null, getClientForAccount: () => undefined };
  return {
    useAuthStore: Object.assign((selector?: (value: typeof state) => unknown) => (selector ? selector(state) : state), {
      getState: () => state,
    }),
  };
});

vi.mock('@/stores/account-store', () => {
  const account = { id: 'a', avatarColor: '#0d9488', email: 'a@example.invalid' };
  const state = { accounts: [account], getAccountById: () => account };
  return {
    useAccountStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  useSettingsStore.setState(initialSettings, true);
  useSettingsStore.setState({
    emailKeywords: [
      { id: 'work', label: 'Work', color: 'red' },
      { id: 'urgent', label: 'Urgent', color: 'blue' },
    ],
    showPreview: false,
    showAccountDot: false,
    tintListRowsByAccount: false,
    mailLayout: 'split',
    interfaceLayout: 'default',
    listColumns: false,
    density: 'regular',
  });
  useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
  useEmailStore.setState({
    selectedEmailKeys: new Set(),
    selectedMailbox: 'inbox',
    isUnifiedView: false,
    mailboxes: [{ id: 'inbox', role: 'inbox' } as never],
  });
});

afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
});

function makeTaggedEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    threadId: 't1',
    from: [{ name: 'Alice', email: 'alice@example.invalid' }],
    mailboxIds: { inbox: true },
    keywords: { $seen: true, '$label:work': true },
    subject: 'Important Work Email',
    preview: 'Work email preview text',
    size: 1024,
    receivedAt: '2026-01-15T10:00:00Z',
    hasAttachment: false,
    ...overrides,
  };
}

describe('tag chips in message rows', () => {
  it('renders tag badges when showTagChips is true', () => {
    useSettingsStore.setState({ showTagChips: true });
    const email = makeTaggedEmail();
    const [thread] = groupEmailsByThread([email]);

    render(
      <ThreadListItem
        thread={thread}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
      />
    );

    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('hides tag badges when showTagChips is false', () => {
    useSettingsStore.setState({ showTagChips: false });
    const email = makeTaggedEmail();
    const [thread] = groupEmailsByThread([email]);

    render(
      <ThreadListItem
        thread={thread}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
      />
    );

    expect(screen.queryByText('Work')).toBeNull();
    // Row content is still fully rendered
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Important Work Email')).toBeInTheDocument();
  });

  it('keeps row tinting by tag active even when showTagChips is false', () => {
    useSettingsStore.setState({ showTagChips: false, tintListRowsByTag: true });
    const email = makeTaggedEmail();
    const [thread] = groupEmailsByThread([email]);

    const { container } = render(
      <ThreadListItem
        thread={thread}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
      />
    );

    expect(screen.queryByText('Work')).toBeNull();
    // The row has red tint applied from the tag
    const rowElement = container.querySelector('[data-email-id="e1"]');
    expect(rowElement?.className).toContain('bg-red-50');
  });

  it.each([true, false])('a collapsed conversation row follows showTagChips=%s', (showTagChips) => {
    useSettingsStore.setState({ showTagChips });
    const [thread] = groupEmailsByThread([
      makeTaggedEmail(),
      makeTaggedEmail({ id: 'e2', receivedAt: '2026-01-16T10:00:00Z', keywords: { $seen: true, '$label:urgent': true } }),
    ]);
    expect(thread.emailCount).toBe(2);

    render(
      <ThreadListItem
        thread={thread}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
      />
    );

    for (const label of ['Work', 'Urgent']) {
      if (showTagChips) expect(screen.getByText(label)).toBeInTheDocument();
      else expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('hides tag badges in expanded child ThreadEmailItem when showTagChips is false', () => {
    useSettingsStore.setState({ showTagChips: false });
    const email = makeTaggedEmail();

    render(<ThreadEmailItem email={email} />);

    expect(screen.queryByText('Work')).toBeNull();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows tag badges in expanded child ThreadEmailItem when showTagChips is true', () => {
    useSettingsStore.setState({ showTagChips: true });
    const email = makeTaggedEmail();

    render(<ThreadEmailItem email={email} />);

    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
