import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// #964: the reading-mode (Sun/Moon) toggle used to mount only once the body
// had loaded and turned out to be HTML. That late mount changed the toolbar
// width and re-ran the overflow calculation, so the other buttons jumped.
// The toggle must be in the DOM from the start, merely disabled.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
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

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    blobId: 'b1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }],
    to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello',
    receivedAt: '2026-01-01T00:00:00Z',
    preview: 'Hello',
    hasAttachment: false,
    size: 100,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
    ...overrides,
  } as unknown as Email;
}

function findToggle(): HTMLElement | null {
  return (
    screen.queryByTitle('view_in_dark_mode') ?? screen.queryByTitle('view_in_light_mode')
  );
}

describe('reading-mode toggle stays mounted (#964)', () => {
  it('is in the DOM while the body is still loading, disabled', () => {
    render(
      <EmailViewer
        email={makeEmail({ htmlBody: [{ partId: '1', type: 'text/html' }] } as never)}
        isLoading
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
      />,
    );

    const toggle = findToggle();
    expect(toggle).not.toBeNull();
    expect(toggle).toBeDisabled();
  });

  it('is enabled once the HTML body is available', () => {
    render(
      <EmailViewer
        email={makeEmail({
          htmlBody: [{ partId: '1', type: 'text/html' }],
          bodyValues: { '1': { value: '<p>Hi</p>', isTruncated: false } },
        } as never)}
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        currentMailboxRole="inbox"
      />,
    );

    const toggle = findToggle();
    expect(toggle).not.toBeNull();
    expect(toggle).not.toBeDisabled();
  });
});
