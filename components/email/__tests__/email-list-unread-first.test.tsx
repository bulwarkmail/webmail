import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email } from '@/lib/jmap/types';

// Mountain View's "Unread first" inbox: the Unread section's conversations
// first, each section under its header, and a folded section's rows gone.

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

const mail = (id: string, time: string, read: boolean): Email => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { inbox: true },
  keywords: read ? { $seen: true } : {},
  size: 1000,
  receivedAt: `2026-09-30T${time}:00Z`,
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});

// The store's list: the section's rows first, then the read mail by date.
const EMAILS = [
  mail('U2', '12:00', false),
  mail('U1', '09:00', false),
  mail('R2', '16:00', true),
  mail('R1', '10:00', true),
];

const initialEmailState = useEmailStore.getState();
const initialTabsState = useMessageListTabsStore.getState();
const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  // Room in the list for every item, or the virtual list draws none of them.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(600);
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({
    selectedMailbox: 'inbox',
    mailboxes: [{ id: 'inbox', role: 'inbox' } as never],
    emails: EMAILS,
    totalEmails: 2,
    unreadSection: { mailboxId: 'inbox', ids: new Set(['U2', 'U1']), total: 7 },
  });
  useMessageListTabsStore.setState(initialTabsState, true);
  useSettingsStore.setState({
    ...initialSettings,
    interfaceLayout: 'mountain-view',
    mvInboxType: 'unread-first',
    mvUnreadSectionCollapsed: false,
    mvEverythingElseCollapsed: false,
  }, true);
});

afterEach(() => { vi.restoreAllMocks(); });

const rowKeys = () => useEmailStore.getState().listRows?.map((row) => row.key);

describe('the "Unread first" inbox list', () => {
  it('puts the Unread section first, under its header, then everything else', () => {
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(rowKeys()).toEqual(['U2', 'U1', 'R2', 'R1']);
    const headers = [...container.querySelectorAll('[data-mv-list-section]')].map((h) => h.textContent);
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('sections.unread');
    expect(headers[1]).toContain('sections.everything_else');
  });

  it('folds a section away from its header', () => {
    const { container } = render(<EmailList emails={EMAILS} />);
    const unreadToggle = container.querySelector('[data-mv-list-section] button') as HTMLButtonElement;
    act(() => unreadToggle.click());
    expect(useSettingsStore.getState().mvUnreadSectionCollapsed).toBe(true);
    expect(rowKeys()).toEqual(['R2', 'R1']);
    expect(container.querySelectorAll('[data-mv-list-section]')).toHaveLength(2);
  });

  it('is one list sorted by date in the default inbox', () => {
    useSettingsStore.setState({ mvInboxType: 'default' });
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(rowKeys()).toEqual(['R2', 'U2', 'R1', 'U1']);
    expect(container.querySelector('[data-mv-list-section]')).toBeNull();
  });
});
