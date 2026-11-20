import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { EmailList } from '../email-list';

// #1798: a conversation with a reply saved as a draft shows a red "Draft" in
// the list, as the reading pane's draft bar does. Derived from the drafts'
// conversations the folder page brought (draftThreads), not read per row.

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

const initial = useEmailStore.getState();
const initialAccounts = useAccountStore.getState();
const folder = (role: string) => ({ id: role, name: role, role, accountId: 'c',
  totalEmails: 3, unreadEmails: 0, totalThreads: 2, unreadThreads: 0,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetKeywords: true } } as Mailbox);

const mail = (id: string, threadId: string, subject: string, receivedAt: string): Email => ({
  id, threadId, blobId: `b-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
  subject, receivedAt, from: [{ email: 'someone@example.invalid' }], size: 1, hasAttachment: false,
} as Email);

// A conversation of two, and two messages on their own.
const newest = mail('newest', 't1', 'Planning', '2026-10-01T09:00:00Z');
const older = mail('older', 't1', 'Planning', '2026-10-01T08:00:00Z');
const lunch = mail('lunch', 't2', 'Lunch', '2026-09-30T09:00:00Z');
const other = mail('other', 't3', 'Other', '2026-09-29T09:00:00Z');
const EMAILS = [newest, older, lunch, other];

function show(role: string, draftThreads: Record<string, string>) {
  useEmailStore.setState({
    emails: EMAILS, mailboxes: [folder(role)], selectedMailbox: role, totalEmails: EMAILS.length,
    threadEmailCounts: new Map([['t1', 3], ['t2', 2], ['t3', 1]]),
    draftThreads: new Map(Object.entries(draftThreads)),
  });
}

beforeEach(() => {
  useAuthStore.setState({ activeAccountId: 'test', client: { getAccountId: () => 'c', getSieveAccountId: () => null, getCapabilities: () => ({}) }, getClientForAccount: () => undefined } as never);
  useSettingsStore.setState({ interfaceLayout: 'default', disableThreading: false, hoverActions: [] } as never);
  useEmailStore.setState(initial, true);
  useAccountStore.setState(initialAccounts, true);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.hasAttribute('data-index') ? 60 : 600;
    return { x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const conversationRow = (container: HTMLElement) => container.querySelector('[data-thread-keys="newest older"]') as HTMLElement;
/** The list item a subject is drawn in, whatever kind of row it is. */
const rowOf = (container: HTMLElement, subject: string) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-index]')).find((item) => item.textContent?.includes(subject))!;
const marker = (rowEl: HTMLElement) => rowEl.querySelector('[data-testid="row-reply-draft"]');

describe('the "Draft" marker in the message list (#1798)', () => {
  it('marks a conversation row and a message row whose conversation has a draft, and no other', () => {
    show('inbox', { d1: 't1', d2: 't2' });
    const { container } = render(<EmailList emails={EMAILS} />);

    expect(marker(conversationRow(container))?.textContent).toBe('draft');
    expect(marker(rowOf(container, 'Lunch'))?.textContent).toBe('draft');
    expect(marker(rowOf(container, 'Other'))).toBeNull();
    expect(container.querySelectorAll('[data-testid="row-reply-draft"]')).toHaveLength(2);
  });

  it('says it to screen readers in the row name', () => {
    show('inbox', { d2: 't2' });
    const { container } = render(<EmailList emails={EMAILS} />);
    const named = rowOf(container, 'Lunch').querySelector('[aria-label*="Lunch"]');
    expect(named?.getAttribute('aria-label')).toContain('draft');
  });

  it('marks a message row with threading off', () => {
    useSettingsStore.setState({ disableThreading: true } as never);
    show('inbox', { d2: 't2' });
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(marker(rowOf(container, 'Lunch'))?.textContent).toBe('draft');
    expect(container.querySelectorAll('[data-testid="row-reply-draft"]')).toHaveLength(1);
  });

  it('shows nothing while the folder knows of no draft', () => {
    show('inbox', {});
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(container.querySelector('[data-testid="row-reply-draft"]')).toBeNull();
  });

  it('shows nothing in Drafts, whose rows are the drafts', () => {
    show('drafts', { d2: 't2' });
    const { container } = render(<EmailList emails={EMAILS} />);
    expect(container.querySelector('[data-testid="row-reply-draft"]')).toBeNull();
  });

  it('opens the message as before on a click', () => {
    show('inbox', { d2: 't2' });
    const onEmailSelect = vi.fn();
    const { container } = render(<EmailList emails={EMAILS} onEmailSelect={onEmailSelect} />);
    fireEvent.click(within(rowOf(container, 'Lunch')).getByText('Lunch'));
    expect(onEmailSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'lunch' }));
  });
});
