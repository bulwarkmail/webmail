import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email } from '@/lib/jmap/types';

/**
 * The list places rows it has not measured by a guess that counts the chip
 * row. With attachment chips turned off a row draws none, so the guess must
 * not count one: a row placed 24px too tall moves every row under it when it
 * is measured.
 */

const virtualizerOptions = vi.hoisted(() => ({ current: null as null | { estimateSize: (index: number) => number } }));

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => {
    virtualizerOptions.current = options;
    return {
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      measureElement: () => {},
      measure: () => {},
      scrollToOffset: () => {},
      scrollToIndex: () => {},
      measurementsCache: [],
      scrollOffset: 0,
      scrollRect: null,
    };
  },
}));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  const client = { getAccountId: () => 'acct-1' };
  return {
    useAuthStore: create(() => ({
      client, identities: [], username: null, activeAccountId: 'acct-1',
      getClientForAccount: () => client,
    })),
  };
});
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  return {
    useAccountStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const MAIL: Email = {
  id: 'm1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2026-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Report',
  preview: 'See the report attached',
  hasAttachment: true,
  attachments: [{ partId: '2', blobId: 'b1', size: 100, type: 'application/pdf', name: 'report.pdf' }],
} as Email;

const initialEmailState = useEmailStore.getState();
const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', emails: [MAIL] });
  useSettingsStore.setState({ density: 'regular', showPreview: true, mailLayout: 'split' });
});

afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
});

function estimateFirstRow(showAttachmentChips: boolean): number {
  useSettingsStore.setState({ showAttachmentChips });
  const { unmount } = render(<EmailList emails={[MAIL]} onOpenAttachment={() => {}} />);
  const estimate = virtualizerOptions.current!.estimateSize(0);
  unmount();
  return estimate;
}

describe('row height guess with attachment chips turned off', () => {
  it('leaves out the chip row', () => {
    const withChips = estimateFirstRow(true);
    const withoutChips = estimateFirstRow(false);
    expect(withChips - withoutChips).toBe(24);
  });
});
