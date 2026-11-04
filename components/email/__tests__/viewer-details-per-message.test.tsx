import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// mail-7: "Show details" stayed open for every message opened after it.
// mail-29: a mail received before it was sent showed a delivery time.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const make = (id: string, sentAt: string, receivedAt: string) => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Sam', email: 'sam@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: `Message ${id}`, sentAt, receivedAt, preview: 'Hello',
  hasAttachment: false, size: 100, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
}) as unknown as Email;

const viewer = (email: Email) => (
  <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" isLoading={false} />
);

describe('message details panel', () => {
  it('closes when another message opens', () => {
    const first = make('e1', '2026-11-03T10:00:00Z', '2026-11-03T10:00:05Z');
    const second = make('e2', '2026-11-03T11:00:00Z', '2026-11-03T11:00:05Z');
    const { rerender } = render(viewer(first));
    act(() => { fireEvent.click(screen.getAllByText('show_details')[0]); });
    expect(screen.queryByText('details.recipients_routing')).not.toBeNull();
    rerender(viewer(second));
    expect(screen.queryByText('details.recipients_routing')).toBeNull();
    // And back on the first one it is closed too: it was opened for that view.
    rerender(viewer(first));
    expect(screen.queryByText('details.recipients_routing')).toBeNull();
  });

  it('shows no delivery time for a mail received before it was sent', () => {
    render(viewer(make('e3', '2026-11-03T21:40:00Z', '2026-11-03T20:40:00Z')));
    act(() => { fireEvent.click(screen.getAllByText('show_details')[0]); });
    expect(screen.queryByText(/details\.delivery_time/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/delivery_time/);
  });

  it('still shows a real delivery time', () => {
    render(viewer(make('e4', '2026-11-03T20:40:00Z', '2026-11-03T21:40:00Z')));
    act(() => { fireEvent.click(screen.getAllByText('show_details')[0]); });
    expect(document.body.textContent).toMatch(/delivery_time/);
  });
});
