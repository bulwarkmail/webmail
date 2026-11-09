import { render } from '@testing-library/react';
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
  const state = { identities: [], username: null };
  return {
    useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

const ACCOUNT_TEAL = { id: 'acct-teal', avatarColor: '#0d9488', label: 'Teal account' };
const ACCOUNT_OTHER = { id: 'acct-other', avatarColor: '#dc2626', label: 'Other account' };
const accountState = {
  accounts: [ACCOUNT_TEAL, ACCOUNT_OTHER] as { id: string }[],
  getAccountById: (id: string) => (id === ACCOUNT_TEAL.id ? ACCOUNT_TEAL : undefined),
};
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
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Test Subject',
  hasAttachment: false,
  accountId: ACCOUNT_TEAL.id,
  accountLabel: ACCOUNT_TEAL.label,
  ...overrides,
});

function renderEmails(emails: Email[]) {
  const [thread] = groupEmailsByThread(emails);
  return render(
    <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />,
  );
}

const single = () => [makeEmail()];
const collapsedThread = () => [
  makeEmail({ id: 'e1', threadId: 't1' }),
  makeEmail({ id: 'e2', threadId: 't1', receivedAt: '2024-01-16T10:00:00Z' }),
];

// The dot is the only element painted in the account colour.
const accountDot = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('span.rounded-full'))
    .find((el) => el.style.backgroundColor === 'rgb(13, 148, 136)') ?? null;

describe('ThreadListItem account dot (#912)', () => {
  beforeEach(() => {
    accountState.accounts = [ACCOUNT_TEAL, ACCOUNT_OTHER];
    useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      interfaceLayout: 'default',
      tintListRowsByAccount: false,
      showAccountDot: true,
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set<string>(),
      selectedMailbox: 'inbox',
      isUnifiedView: true,
    });
  });

  it('is on by default', () => {
    expect(useSettingsStore.getInitialState().showAccountDot).toBe(true);
  });

  describe.each([
    ['single message', single],
    ['collapsed thread', collapsedThread],
  ])('%s', (_name, emails) => {
    describe.each(['split', 'focus'] as const)('%s layout', (layout) => {
      beforeEach(() => {
        useSettingsStore.setState({ mailLayout: layout });
      });

      it('shows the dot in the unified view', () => {
        const { container } = renderEmails(emails());
        expect(accountDot(container)).not.toBeNull();
      });

      it('hides the dot when the setting is off', () => {
        useSettingsStore.setState({ showAccountDot: false });
        const { container } = renderEmails(emails());
        expect(accountDot(container)).toBeNull();
        // The rest of the row still renders.
        expect(container.textContent).toContain('Test Subject');
      });

      it('hides the dot with only one account signed in', () => {
        accountState.accounts = [ACCOUNT_TEAL];
        const { container } = renderEmails(emails());
        expect(accountDot(container)).toBeNull();
        expect(container.textContent).toContain('Test Subject');
      });
    });
  });
});
