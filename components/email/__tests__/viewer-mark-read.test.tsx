import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

// A read change the server refuses (a read-only shared folder, on Stalwart
// 0.16 and 1.0) is reported by the host when the user asked for it, but not
// when the viewer marks an opened message read on its own: that would
// complain about every unread message opened in such a folder.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: () => [],
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const unread = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: {},
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z',
  preview: 'Hello',
  hasAttachment: false,
  size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [],
  attachments: [],
  bodyValues: { '1': { value: 'Hello Bob', isTruncated: false } },
} as unknown as Email;

const originalDelay = useSettingsStore.getState().markAsReadDelay;

afterEach(() => {
  useSettingsStore.setState({ markAsReadDelay: originalDelay });
  vi.restoreAllMocks();
});

describe('EmailViewer mark as read', () => {
  it('marks an opened message read as an automatic change', async () => {
    useSettingsStore.setState({ markAsReadDelay: 0 });
    const onMarkAsRead = vi.fn();

    render(<EmailViewer email={unread} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onMarkAsRead={onMarkAsRead} />);

    await waitFor(() => expect(onMarkAsRead).toHaveBeenCalledWith('e1', true, { automatic: true }));
  });

  it('a message opened from a link stays unread until the user says', async () => {
    useSettingsStore.setState({ markAsReadDelay: 0 });
    const onMarkAsRead = vi.fn();
    render(<EmailViewer email={unread} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onMarkAsRead={onMarkAsRead} noAutomaticActions />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onMarkAsRead).not.toHaveBeenCalled();
  });

  it("passes the toolbar button on as the user's own change", () => {
    useSettingsStore.setState({ markAsReadDelay: -1 });
    const onMarkAsRead = vi.fn();

    render(<EmailViewer email={unread} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onMarkAsRead={onMarkAsRead} />);
    fireEvent.click(screen.getAllByTitle('mark_read')[0]);

    expect(onMarkAsRead).toHaveBeenCalledTimes(1);
    expect(onMarkAsRead.mock.calls[0]).toEqual(['e1', true]);
  });
});
