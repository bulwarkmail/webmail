import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { MAIL_SHORTCUTS } from '@/lib/keyboard-shortcuts/mail';
import { messageActionShortcut } from '../message-action-shortcuts';

// mail-p2-13: Reply all read "Reply all (a)" in the toolbar, "Shift + R" in
// the menus and "R" in the help; Delete "# or Del" against "Del". The three
// places now name the same key.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];
const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], to: [], subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z',
  preview: '', hasAttachment: false, size: 1, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
} as unknown as Email;

const helpKey = (description: string) =>
  MAIL_SHORTCUTS.actions.find((entry) => entry.description === description)!.key;

describe('shortcut hints', () => {
  it('give Reply all and Delete the same key in the help as in the menus', () => {
    expect(helpKey('shortcuts.actions.reply_all')).toBe(messageActionShortcut('reply_all', { singleKeys: true }));
    expect(helpKey('shortcuts.actions.delete')).toBe(messageActionShortcut('delete', { singleKeys: true }));
  });

  it('name the menus\' keys in the toolbar tooltips', () => {
    const { container } = render(
      <EmailViewer
        email={email}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
        onReply={vi.fn()}
        onReplyAll={vi.fn()}
        onForward={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onMoveToMailbox={vi.fn()}
      />,
    );
    const titles = Array.from(container.querySelectorAll<HTMLElement>('button[title]')).map((b) => b.title);
    expect(titles).toContain('reply_all (Shift + R)');
    expect(titles).toContain('delete (Del)');
    expect(titles).toContain('reply (R)');
  });
});
