import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The message details panel in a narrow reader: the two columns followed the
// window's width, not the panel's, so they stayed side by side in a narrow pane;
// the sender's address went letter by letter down a sliver of a column, dates took
// three lines, and long sign-in results ran off the side.

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

const ADDRESS = 'no-reply-x8@notifications.mail.example-service.example.net';
const SPF_DOMAIN = 'bounces+31859940-0dcc@em9672.notifications.example-service.example.net';

const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Example Service', email: ADDRESS }], to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Hello', sentAt: '2026-11-04T04:33:50Z', receivedAt: '2026-11-04T04:33:53Z', preview: 'Hello',
  hasAttachment: false, size: 100, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
  authenticationResults: { spf: { result: 'pass', domain: SPF_DOMAIN } },
} as unknown as Email;

function openDetails() {
  render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" isLoading={false} />);
  act(() => { fireEvent.click(screen.getAllByText('show_details')[0]); });
  const heading = screen.getByText('details.recipients_routing');
  return heading.closest('section')!;
}

describe('message details panel', () => {
  it('lays out by its own width, not the window', () => {
    const routing = openDetails();
    const grid = routing.parentElement!;
    expect(grid.className).toMatch(/@3xl:grid-cols-2/);
    expect(grid.className).not.toMatch(/\blg:grid-cols-2/);
    expect(grid.parentElement!.className).toMatch(/@container/);
    // The value column may shrink below its content's width.
    expect(routing.querySelector('dl')!.className).toContain('minmax(0,1fr)');
  });

  it('shows the sender name and address apart, the address breakable at its dots', () => {
    const routing = openDetails();
    expect(routing.textContent).not.toContain(`<${ADDRESS}>`);
    const address = routing.querySelector(`[title="${ADDRESS}"]`)!;
    expect(address.textContent).toBe(ADDRESS);
    expect(address.querySelectorAll('wbr').length).toBeGreaterThan(2);
  });

  it('shows dates short, with the full date on hover', () => {
    const routing = openDetails();
    const times = routing.querySelectorAll('time');
    expect(times.length).toBe(2);
    for (const time of Array.from(times)) {
      expect(time.getAttribute('title')!.length).toBeGreaterThan(time.textContent!.length);
    }
  });

  it('keeps sign-in result chips inside the panel, the long part cut with the whole on hover', () => {
    openDetails();
    const domain = screen.getByText(SPF_DOMAIN);
    expect(domain.className).toContain('truncate');
    expect(domain.getAttribute('title')).toBe(SPF_DOMAIN);
    expect(domain.parentElement!.className).toContain('max-w-full');
  });
});
