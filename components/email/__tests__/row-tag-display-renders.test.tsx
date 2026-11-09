import { render, act, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import type { TagDisplay, TagDisplaySource } from '@/hooks/use-tag-display';

// The list measures its width once the rows are on screen and tells the rows
// how to draw tags. Only rows with tags (or a folder chip) follow it: the
// first measurement drew every row again, though most rows draw no tag.

// Called once per render of a row: the render counter.
const useEmailDrag = vi.fn((opts: { email: Email }) => { void opts; return { dragHandlers: {}, isDragging: false }; });
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag }));
vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null };
  return { useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state) };
});

const { ThreadListItem } = await import('../thread-list-item');
const { TagDisplaySourceContext } = await import('@/hooks/use-tag-display');
const { groupEmailsByThread } = await import('@/lib/thread-utils');

const mail = (id: string, keywords: Record<string, boolean>) => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true, ...keywords }, size: 1,
  receivedAt: '2026-01-15T10:00:00Z', subject: `Subject ${id}`,
  from: [{ name: `Sender ${id}`, email: `${id}@example.com` }],
}) as unknown as Email;

function makeSource(initial: TagDisplay) {
  let current = initial;
  const listeners = new Set<() => void>();
  const source: TagDisplaySource & { set(next: TagDisplay): void } = {
    get: () => current,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set(next) { current = next; listeners.forEach((fn) => fn()); },
  };
  return source;
}

describe('rows and the measured tag display', () => {
  it('draws again only the rows that show tags', () => {
    const source = makeSource({ variant: 'badge', placement: 'subject', tight: false });
    const [plain] = groupEmailsByThread([mail('plain', {})]);
    const [tagged] = groupEmailsByThread([mail('tagged', { '$label:work': true })]);
    render(
      <TagDisplaySourceContext.Provider value={source}>
        <ThreadListItem thread={plain} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />
        <ThreadListItem thread={tagged} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />
      </TagDisplaySourceContext.Provider>,
    );
    expect(screen.getByText('Sender plain')).toBeInTheDocument();
    useEmailDrag.mockClear();
    act(() => { source.set({ variant: 'dot', placement: 'sender', tight: true }); });
    const drawn = useEmailDrag.mock.calls.map((call) => call[0].email.id);
    expect(drawn).toEqual(['tagged']);
  });
});
