import { render, act, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// A message row follows the role of the folder it is listed in (sender vs
// recipient, junk actions), not the folder list itself: the list is a new
// array on every count update, and each one re-rendered every row.

// Called once per render of a row: the render counter.
const useEmailDrag = vi.fn(() => ({ dragHandlers: {}, isDragging: false }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag }));
vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null };
  return { useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state) };
});

const { ThreadListItem } = await import('../thread-list-item');
const { useEmailStore } = await import('@/stores/email-store');
const { groupEmailsByThread } = await import('@/lib/thread-utils');

const folder = (id: string, role: string | null, unreadEmails = 0) =>
  ({ id, name: id, role, unreadEmails, totalEmails: 1 }) as unknown as Mailbox;
const email = {
  id: 'e1', threadId: 't1', mailboxIds: { sent: true }, keywords: { $seen: true }, size: 1,
  receivedAt: '2026-01-15T10:00:00Z', subject: 'Hello',
  from: [{ name: 'Me', email: 'me@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
} as unknown as Email;

describe('message row store subscription', () => {
  it('ignores folder list updates that leave its folder role alone', () => {
    useEmailStore.setState({ selectedMailbox: 'sent', isUnifiedView: false, unifiedRole: null, mailboxes: [folder('inbox', 'inbox'), folder('sent', 'sent')] });
    const [thread] = groupEmailsByThread([email]);
    render(<ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />);
    // Sent shows the recipient.
    expect(screen.getByText('Bob')).toBeInTheDocument();
    const mounted = useEmailDrag.mock.calls.length;

    // A count update: a new folder list, same roles.
    act(() => { useEmailStore.setState({ mailboxes: [folder('inbox', 'inbox', 3), folder('sent', 'sent')] }); });
    expect(useEmailDrag.mock.calls.length).toBe(mounted);

    // The folder's role itself changing still shows.
    act(() => { useEmailStore.setState({ mailboxes: [folder('inbox', 'inbox', 3), folder('sent', null)] }); });
    expect(useEmailDrag.mock.calls.length).toBeGreaterThan(mounted);
    expect(screen.getByText('Me')).toBeInTheDocument();
  });

  it('draws a one-message row once, not as a conversation row around it', () => {
    useEmailStore.setState({ selectedMailbox: 'sent', isUnifiedView: false, unifiedRole: null, mailboxes: [folder('inbox', 'inbox'), folder('sent', 'sent')] });
    const [thread] = groupEmailsByThread([email]);
    useEmailDrag.mockClear();
    render(<ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />);
    // One component drags it: the conversation row's hooks don't run for one message.
    expect(useEmailDrag).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });
});
