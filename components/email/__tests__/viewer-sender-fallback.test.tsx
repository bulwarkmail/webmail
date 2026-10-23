import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

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

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    blobId: 'blob-1',
    threadId: 'thread-1',
    mailboxIds: { sent: true },
    keywords: { $seen: true },
    size: 100,
    receivedAt: '2026-10-21T04:19:42Z',
    from: undefined,
    to: [{ name: 'Recipient', email: 'recipient@example.com' }],
    subject: 'Sent without from header',
    bodyValues: { '1': { value: 'Body' } },
    textBody: [{ partId: '1', type: 'text/plain' }],
    ...overrides,
  };
}

describe('EmailViewer sender fallback', () => {
  it('falls back to mailbox owner in sent folder when email.from is missing', () => {
    const email = makeEmail({ from: undefined });

    render(
      <EmailViewer
        email={email}
        currentUserEmail="sender@example.com"
        currentUserName="Sender Name"
        currentMailboxRole="sent"
        selectedMailbox="sent"
        mailboxes={[{ id: 'sent', name: 'Sent', role: 'sent', parentId: null } as Mailbox]}
      />
    );

    // Should render the sender's name instead of Unknown
    expect(screen.getByText('Sender Name')).toBeInTheDocument();
  });

  it('renders unknown sender in inbox when email.from is missing', () => {
    const email = makeEmail({ from: undefined, mailboxIds: { inbox: true } });

    render(
      <EmailViewer
        email={email}
        currentUserEmail="user@example.com"
        currentUserName="User Name"
        currentMailboxRole="inbox"
        selectedMailbox="inbox"
        mailboxes={[{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null } as Mailbox]}
      />
    );

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
