import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';

// Hover actions mount on the first pointer-over and stay, hidden until the
// pointer is over the row. A row the list keeps for the next message (a
// folder switch) starts without them again, as a new row did: carried along,
// every row once pointed at kept a hidden set of buttons in the page.

vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null, client: null, activeAccountId: null };
  const hook = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  hook.getState = () => state;
  hook.subscribe = () => () => {};
  return { useAuthStore: hook };
});

const { ThreadListItem } = await import('../thread-list-item');
const { groupEmailsByThread } = await import('@/lib/thread-utils');

const mail = (id: string) => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true }, size: 1,
  receivedAt: '2026-01-15T10:00:00Z', subject: `Subject ${id}`,
  from: [{ name: `Sender ${id}`, email: `${id}@example.com` }],
}) as unknown as Email;

const row = (email: Email) => {
  const [thread] = groupEmailsByThread([email]);
  return <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />;
};

describe('hover actions on a kept row', () => {
  it('are not carried over to the next message', () => {
    const { container, rerender } = render(row(mail('a')));
    const item = container.querySelector('[data-testid="email-list-item"]')!;
    fireEvent.pointerOver(item);
    expect(container.querySelector('[data-testid^="hover-action-"]')).not.toBeNull();
    rerender(row(mail('b')));
    expect(container.querySelector('[data-email-id="b"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="hover-action-"]')).toBeNull();
    // Back to the first message (back to its folder): unarmed, as a new row.
    rerender(row(mail('a')));
    expect(container.querySelector('[data-email-id="a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="hover-action-"]')).toBeNull();
  });
});
