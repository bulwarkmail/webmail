import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { EmailList } from '../email-list';

// #460: a collapsed conversation row shows every tag of its messages. Tagging
// it from the row's menu or hover button covers every message, and its tag
// list shows a tag as set while any message has it.

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

const initial = useEmailStore.getState();
const initialAccounts = useAccountStore.getState();
const inbox = { id: 'inbox', name: 'inbox', role: 'inbox', accountId: 'c',
  totalEmails: 2, unreadEmails: 0, totalThreads: 1, unreadThreads: 0,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetKeywords: true } } as Mailbox;

const mail = (id: string, receivedAt: string, keywords: Record<string, boolean>): Email => ({
  id, threadId: 't1', blobId: `b-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true, ...keywords },
  subject: 'Planning', receivedAt, from: [{ email: 'someone@example.invalid' }], size: 1, hasAttachment: false,
} as Email);

// Only the older message carries the tag.
const older = mail('older', '2026-10-01T08:00:00Z', { '$label:work': true });
const newest = mail('newest', '2026-10-01T09:00:00Z', {});

beforeEach(() => {
  useAuthStore.setState({ activeAccountId: 'test', client: { getAccountId: () => 'c', getSieveAccountId: () => null, getCapabilities: () => ({}) }, getClientForAccount: () => undefined } as never);
  useSettingsStore.setState({
    interfaceLayout: 'default', disableThreading: false, hoverActions: ['tag'],
    emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }, { id: 'home', label: 'Home', color: 'green' }],
    nestedTags: false,
  } as never);
  useEmailStore.setState(initial, true);
  useAccountStore.setState(initialAccounts, true);
  useEmailStore.setState({ emails: [newest, older], mailboxes: [inbox], selectedMailbox: 'inbox', totalEmails: 2 });
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
const tagItem = (label: string) => screen.getAllByRole('menuitemcheckbox').find((item) => item.textContent?.includes(label))!;

describe('tagging a collapsed conversation row (#460)', () => {
  it('shows a tag of an older message as set in the row menu, and covers every message', () => {
    const onSetTag = vi.fn();
    const { container } = render(<EmailList emails={[newest, older]} onSetTag={onSetTag} />);

    fireEvent.contextMenu(conversationRow(container));
    act(() => { fireEvent.mouseEnter(screen.getByTestId('ctx-tag')); });
    expect(tagItem('Work').getAttribute('aria-checked')).toBe('true');
    expect(tagItem('Home').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(tagItem('Home'));
    expect(onSetTag).toHaveBeenCalledTimes(1);
    const [, tagId, , conversation] = onSetTag.mock.calls[0];
    expect(tagId).toBe('home');
    expect((conversation as Email[]).map((e) => e.id).sort()).toEqual(['newest', 'older']);
  });

  it('covers every message from the hover tag button', () => {
    const onSetTag = vi.fn();
    const { container } = render(<EmailList emails={[newest, older]} onSetTag={onSetTag} />);
    fireEvent.pointerOver(conversationRow(container));
    fireEvent.click(container.querySelector('[data-testid="hover-action-tag"]') as HTMLElement);
    expect(tagItem('Work').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(tagItem('Work'));
    const [, tagId, , conversation] = onSetTag.mock.calls[0];
    expect(tagId).toBe('work');
    expect((conversation as Email[]).map((e) => e.id).sort()).toEqual(['newest', 'older']);
  });
});
