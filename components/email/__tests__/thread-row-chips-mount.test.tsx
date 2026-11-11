import { render, act, screen } from '@testing-library/react';
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

const row = (id: string, hasAttachment: boolean, over: Partial<Email> = {}) => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true }, size: 1,
  receivedAt: '2026-01-15T10:00:00Z', subject: id, from: [{ name: 'Ann', email: 'ann@example.com' }], hasAttachment,
  ...over,
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

  // With the chips turned off a row keeps its verification code and its
  // paperclip, and mounts no loader for the chips.
  it('keeps the code and the paperclip when attachment chips are off', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    act(() => { useSettingsStore.setState({ showAttachmentChips: false }); });
    try {
      ListAttachmentChips.mockClear();
      const email = row('with', true, { subject: 'Your verification code is 482913', receivedAt: new Date().toISOString() });
      const [thread] = groupEmailsByThread([email]);
      const { unmount } = render(
        <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} onOpenAttachment={() => {}} />,
      );
      expect(ListAttachmentChips).not.toHaveBeenCalled();
      expect(screen.getAllByText('482913').length).toBeGreaterThan(0);
      expect(screen.getAllByText('has_attachment').length).toBeGreaterThan(0);
      unmount();
    } finally {
      act(() => { useSettingsStore.setState({ showAttachmentChips: true }); });
    }
  });
});
