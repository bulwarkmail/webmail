import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email } from '@/lib/jmap/types';

// "Group by date": the list under Today, Yesterday, weekday, Last week, Last
// month and Older headers while it runs by date, each folding its rows away.

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({ client: null, identities: [], username: null, activeAccountId: 'acct-1' })),
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

// Thursday, 12 November 2026.
const NOW = new Date('2026-11-12T11:00:00Z');

const mail = (id: string, receivedAt: string, pinned = false): Email => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { inbox: true },
  keywords: pinned ? { $seen: true, $pinned: true } : { $seen: true },
  size: 1000,
  receivedAt,
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});

const EMAILS = [
  mail('T1', '2026-11-12T09:00:00Z'),
  mail('T2', '2026-11-12T08:00:00Z'),
  mail('Y1', '2026-11-11T09:00:00Z'),
  mail('M1', '2026-11-09T09:00:00Z'), // Monday
  mail('W1', '2026-11-03T09:00:00Z'),
  mail('L1', '2026-10-25T09:00:00Z'),
  mail('O1', '2026-09-01T09:00:00Z'),
];

const initialEmailState = useEmailStore.getState();
const initialTabsState = useMessageListTabsStore.getState();
const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // Room in the list for every item, or the virtual list draws none of them.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(2000);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(600);
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({
    selectedMailbox: 'inbox',
    mailboxes: [{ id: 'inbox', role: 'inbox' } as never],
    emails: EMAILS,
    totalEmails: EMAILS.length,
    listOrder: [],
  });
  useMessageListTabsStore.setState(initialTabsState, true);
  useSettingsStore.setState({ ...initialSettings, groupListByDate: true, timeZone: 'Europe/Berlin', dateLocale: 'en-US' }, true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rowKeys = () => useEmailStore.getState().listRows?.map((row) => row.key);
const headers = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-list-date-group]')].map((h) => h.textContent);

describe('the list grouped by date', () => {
  it('puts the rows under date headers, newest first', () => {
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(headers(container)).toEqual([
      'date_groups.today',
      'date_groups.yesterday',
      'Monday',
      'date_groups.last_week',
      'date_groups.last_month',
      'date_groups.older',
    ]);
    expect(rowKeys()).toEqual(['T1', 'T2', 'Y1', 'M1', 'W1', 'L1', 'O1']);
    // Headers are not options of the list.
    expect(container.querySelectorAll('[data-list-date-group] [role="option"], [data-list-date-group][role="row"]')).toHaveLength(0);
  });

  it('turns the groups around oldest first', () => {
    const oldest = [...EMAILS].reverse();
    useEmailStore.setState({ emails: oldest, listOrder: [{ criterion: 'receivedAt', direction: 'asc' }] });
    const { container } = render(<EmailList emails={oldest} />);
    expect(headers(container)[0]).toBe('date_groups.older');
    expect(headers(container).at(-1)).toBe('date_groups.today');
  });

  it('shows no headers with the setting off', () => {
    useSettingsStore.setState({ groupListByDate: false });
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(headers(container)).toEqual([]);
    expect(rowKeys()).toEqual(['T1', 'T2', 'Y1', 'M1', 'W1', 'L1', 'O1']);
  });

  it('shows no headers sorted by sender', () => {
    useEmailStore.setState({ listOrder: [{ criterion: 'from', direction: 'asc' }] });
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(headers(container)).toEqual([]);
  });

  it('shows headers for search results whatever the folder order', () => {
    useEmailStore.setState({ listOrder: [{ criterion: 'from', direction: 'asc' }], searchQuery: 'mail' });
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(headers(container)[0]).toBe('date_groups.today');
  });

  it('leaves the "Unread first" sections alone', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', mvInboxType: 'unread-first' });
    useEmailStore.setState({ unreadSection: { mailboxId: 'inbox', ids: new Set(['Y1']), total: 1 } });
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(headers(container)).toEqual([]);
    expect(container.querySelectorAll('[data-mv-list-section]')).toHaveLength(2);
  });

  it('shows no headers in the Scheduled view', () => {
    const { container } = render(<EmailList emails={EMAILS} isScheduledView />);
    expect(headers(container)).toEqual([]);
  });

  it('folds a group away from its header and opens it again', () => {
    const { container } = render(<EmailList emails={EMAILS} />);
    const today = container.querySelector('[data-list-date-group] button') as HTMLButtonElement;
    expect(today.getAttribute('aria-expanded')).toBe('true');
    act(() => today.click());
    expect(rowKeys()).toEqual(['Y1', 'M1', 'W1', 'L1', 'O1']);
    const folded = container.querySelector('[data-list-date-group] button') as HTMLButtonElement;
    expect(folded.getAttribute('aria-expanded')).toBe('false');
    expect(headers(container)).toHaveLength(6);
    act(() => folded.click());
    expect(rowKeys()).toEqual(['T1', 'T2', 'Y1', 'M1', 'W1', 'L1', 'O1']);
  });

  it('puts pinned threads under Pinned, above the dates', () => {
    const emails = [mail('P1', '2026-10-01T09:00:00Z', true), ...EMAILS];
    useEmailStore.setState({ emails });
    const { container } = render(<EmailList emails={emails} />);
    expect(headers(container).slice(0, 2)).toEqual(['pinned', 'date_groups.today']);
    expect(rowKeys()?.[0]).toBe('P1');
  });
});
