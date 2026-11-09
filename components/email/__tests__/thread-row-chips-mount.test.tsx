import { render, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';

// A row without an attachment mounts no attachment loader: there is nothing
// for it to load or show, and the list mounts dozens of rows at a time.

const ListAttachmentChips = vi.fn(() => null);
vi.mock('../attachment-chips', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../attachment-chips')>()),
  ListAttachmentChips,
}));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null };
  return { useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state) };
});

const { ThreadListItem } = await import('../thread-list-item');
const { groupEmailsByThread } = await import('@/lib/thread-utils');

const row = (id: string, hasAttachment: boolean) => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true }, size: 1,
  receivedAt: '2026-01-15T10:00:00Z', subject: id, from: [{ name: 'Ann', email: 'ann@example.com' }], hasAttachment,
}) as unknown as Email;

describe('attachment chips in message rows', () => {
  it('mounts the loader only for rows that may have attachments', () => {
    for (const [email, expected] of [[row('plain', false), 0], [row('with', true), 1]] as const) {
      ListAttachmentChips.mockClear();
      const [thread] = groupEmailsByThread([email]);
      const { unmount } = render(
        <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} onOpenAttachment={() => {}} />,
      );
      expect(ListAttachmentChips.mock.calls.length > 0 ? 1 : 0).toBe(expected);
      unmount();
    }
  });

  it('does not mount the loader when showAttachmentChips is off', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    act(() => { useSettingsStore.setState({ showAttachmentChips: false }); });
    try {
      ListAttachmentChips.mockClear();
      const [thread] = groupEmailsByThread([row('with', true)]);
      const { unmount } = render(
        <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} onOpenAttachment={() => {}} />,
      );
      expect(ListAttachmentChips).not.toHaveBeenCalled();
      unmount();
    } finally {
      act(() => { useSettingsStore.setState({ showAttachmentChips: true }); });
    }
  });
});
