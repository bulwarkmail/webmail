import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { listLeadClass } from '../list-columns';
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
  keywords: {},
  size: 1000,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Test Subject',
  preview: PREVIEW,
  hasAttachment: false,
  ...overrides,
});

const SINGLE = () => [makeEmail()];
const CONVERSATION = () => [
  makeEmail({ id: 'older', receivedAt: '2024-01-14T10:00:00Z' }),
  makeEmail({ id: 'newer', receivedAt: '2024-01-15T10:00:00Z' }),
];

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

// "Normal without avatars" is the regular row with the avatar left out: the
// preview stays, the unread dot moves to the row's edge and a checkbox stands
// in for the avatar while selecting, as in extra compact.
describe.each([
  ['single message', SINGLE],
  ['conversation', CONVERSATION],
] as const)('a %s row at regular-no-avatars', (_kind, emails) => {
  it('draws no avatar but keeps the preview line', () => {
    useSettingsStore.setState({ density: 'regular-no-avatars' });
    const { container } = renderRow(emails());
    expect(container.querySelector('[data-select-gutter]')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(PREVIEW).className.split(/\s+/)).toContain('line-clamp-1');
  });

  it('still marks an unread row', () => {
    useSettingsStore.setState({ density: 'regular-no-avatars' });
    const { container } = renderRow(emails());
    expect(container.querySelector('.fill-unread')).not.toBeNull();
  });

  it('offers a checkbox while selecting', () => {
    useSettingsStore.setState({ density: 'regular-no-avatars' });
    useEmailStore.setState({ selectedEmailKeys: new Set<string>(['other']) });
    renderRow(emails());
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('keeps the avatar at regular', () => {
    useSettingsStore.setState({ density: 'regular' });
    const { container } = renderRow(emails());
    expect(container.querySelector('[data-select-gutter]')).not.toBeNull();
  });
});

describe('listLeadClass', () => {
  it('reserves the avatar width only where rows draw one', () => {
    expect(listLeadClass('regular', false)).toBe('w-8');
    expect(listLeadClass('regular-no-avatars', false)).toBeNull();
    expect(listLeadClass('regular-no-avatars', true)).toBe(listLeadClass('extra-compact', true));
  });
});
