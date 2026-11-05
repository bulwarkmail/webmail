import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// A message opened from a file (desktop-p3-5) is in no folder: the reader offers
// answering, Print and Move (an import), not what acts on a stored message.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'old', name: 'Old mail', role: null, parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const email = {
  id: 'blob-1',
  blobId: 'blob-1',
  threadId: '',
  mailboxIds: {},
  keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'From a file',
  receivedAt: '2026-01-01T00:00:00Z',
  preview: 'Hello',
  hasAttachment: false,
  size: 100,
  textBody: [],
  htmlBody: [],
  attachments: [],
  bodyValues: {},
} as unknown as Email;

function viewer(savedFile: boolean) {
  return render(
    <EmailViewer
      email={email}
      savedFile={savedFile}
      mailboxes={mailboxes}
      onReply={vi.fn()}
      onReplyAll={vi.fn()}
      onForward={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onToggleStar={vi.fn()}
      onMarkAsRead={vi.fn()}
      onSetTag={vi.fn()}
      onMoveToMailbox={vi.fn()}
    />,
  );
}

const storedOnly = () => [
  screen.queryByTitle('archive (E)'),
  screen.queryByTestId('reader-delete'),
  screen.queryByTitle('set_tag'),
  screen.queryByTitle('mark_unread'),
  screen.queryByTestId('subject-star'),
];

describe('the reader with a message from a file', () => {
  it('a stored message has archive, delete, tag, read state and star', () => {
    viewer(false);
    expect(storedOnly().every((button) => button !== null)).toBe(true);
  });

  it('leaves out what acts on a stored message, and keeps answering, Print and Move', () => {
    viewer(true);
    expect(storedOnly()).toEqual([null, null, null, null, null]);
    expect(screen.getByTitle('reply (R)')).toBeInTheDocument();
    expect(screen.getByTitle('forward (F)')).toBeInTheDocument();
    expect(screen.getByTitle('print')).toBeInTheDocument();
    expect(screen.getByTitle('move_to')).toBeInTheDocument();
  });

  // Delete and star are on the toolbar, so the menu leaves them out anyway.
  const STORED_ENTRIES = ['ctx-mark-unread', 'ctx-tag', 'ctx-spam', 'ctx-export'];
  const menuTestIds = () => {
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    return [...document.querySelectorAll('[data-testid^="ctx-"]')].map((node) => node.getAttribute('data-testid'));
  };

  it('a stored message\'s ⋮ menu has them', () => {
    viewer(false);
    expect(menuTestIds()).toEqual(expect.arrayContaining(STORED_ENTRIES));
  });

  it('its ⋮ menu has no read state, tags, spam or download either, and keeps Move', () => {
    viewer(true);
    const ids = menuTestIds();
    expect(ids).toEqual(expect.arrayContaining(['ctx-move-to', 'ctx-view-source']));
    for (const testId of STORED_ENTRIES) expect(ids).not.toContain(testId);
  });
});
