import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';
import { conversationInList } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { EmailList } from '../email-list';

// #1683: a conversation row is bold while any of its messages is unread. Its
// read/unread action has to say and do the same: offer "Mark as read" then,
// and mark every message of the conversation, not only the newest.

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

const initial = useEmailStore.getState();
const initialAccounts = useAccountStore.getState();
const inbox = { id: 'inbox', name: 'inbox', role: 'inbox', accountId: 'c',
  totalEmails: 2, unreadEmails: 1, totalThreads: 1, unreadThreads: 1,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true } } as Mailbox;

const mail = (id: string, receivedAt: string, seen: boolean): Email => ({
  id, threadId: 't1', blobId: `b-${id}`, mailboxIds: { inbox: true }, keywords: seen ? { $seen: true } : {},
  subject: 'Planning', receivedAt, from: [{ email: 'someone@example.invalid' }], size: 1, hasAttachment: false,
} as Email);

// The older message is still unread, the newest one read.
const older = mail('older', '2026-10-01T08:00:00Z', false);
const newest = mail('newest', '2026-10-01T09:00:00Z', true);

beforeEach(() => {
  useAuthStore.setState({ activeAccountId: 'test', client: { getAccountId: () => 'c', getSieveAccountId: () => null, getCapabilities: () => ({}) }, getClientForAccount: () => undefined } as never);
  useSettingsStore.setState({ interfaceLayout: 'default', disableThreading: false, hoverActions: ['markRead'] } as never);
  useEmailStore.setState(initial, true);
  useAccountStore.setState(initialAccounts, true);
  useEmailStore.setState({ emails: [newest, older], mailboxes: [inbox], selectedMailbox: 'inbox', totalEmails: 2 });
  // Give jsdom's virtualized rows a layout so they render.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.hasAttribute('data-index') ? 60 : 300;
    return { x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const conversationRow = (container: HTMLElement) => container.querySelector('[data-thread-keys="newest older"]') as HTMLElement;

describe('a conversation row with an older unread message (#1683)', () => {
  it('offers and does Mark as read for the whole conversation from its menu', () => {
    const onMarkAsRead = vi.fn();
    const { container } = render(<EmailList emails={[newest, older]} onMarkAsRead={onMarkAsRead} />);
    const row = conversationRow(container);
    expect(row.getAttribute('data-unread')).toBe('true');

    fireEvent.contextMenu(row);
    expect(screen.queryByTestId('ctx-mark-unread')).toBeNull();
    fireEvent.click(screen.getByTestId('ctx-mark-read'));

    expect(onMarkAsRead).toHaveBeenCalledTimes(1);
    const [, read, conversation] = onMarkAsRead.mock.calls[0];
    expect(read).toBe(true);
    expect((conversation as Email[]).map((e) => e.id).sort()).toEqual(['newest', 'older']);
  });

  it('offers and does Mark as read for the whole conversation from its hover button', () => {
    const onMarkAsRead = vi.fn();
    const { container } = render(<EmailList emails={[newest, older]} onMarkAsRead={onMarkAsRead} />);
    const row = conversationRow(container);
    fireEvent.pointerOver(row);
    const button = container.querySelector('[data-testid="hover-action-markRead"]') as HTMLElement;
    expect(button.getAttribute('aria-label') ?? button.getAttribute('title')).toBe('mark_read');

    fireEvent.click(button);
    const [, read, conversation] = onMarkAsRead.mock.calls[0];
    expect(read).toBe(true);
    expect((conversation as Email[]).map((e) => e.id).sort()).toEqual(['newest', 'older']);
  });

  it('marks the whole conversation unread once all of it is read', () => {
    const allRead = [newest, { ...older, keywords: { $seen: true } }];
    useEmailStore.setState({ emails: allRead });
    const onMarkAsRead = vi.fn();
    const { container } = render(<EmailList emails={allRead} onMarkAsRead={onMarkAsRead} />);
    fireEvent.contextMenu(conversationRow(container));
    fireEvent.click(screen.getByTestId('ctx-mark-unread'));
    const [, read, conversation] = onMarkAsRead.mock.calls[0];
    expect(read).toBe(false);
    expect((conversation as Email[]).map((e) => e.id).sort()).toEqual(['newest', 'older']);
  });
});

describe('conversationInList (the keyboard shortcut on a conversation row)', () => {
  const other = { ...mail('other', '2026-10-01T10:00:00Z', false), threadId: 't2' } as Email;

  it('gives every message of the open message’s conversation in the list', () => {
    expect(conversationInList(newest, [other, newest, older]).map((e) => e.id).sort()).toEqual(['newest', 'older']);
  });

  it('keeps a message the list doesn’t hold on its own', () => {
    const elsewhere = mail('elsewhere', '2026-10-01T07:00:00Z', false);
    expect(conversationInList(elsewhere, [newest, older])).toEqual([elsewhere]);
  });
});
