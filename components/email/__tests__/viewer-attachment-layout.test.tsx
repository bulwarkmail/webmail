import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The attachment position setting decides where the reader draws the
// attachments: a bar of tiles above the body, or cards after it with a
// paperclip in the header that jumps down to them.

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
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const email = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ name: 'Sarah Kim', email: 'sarah@example.com' }],
  to: [{ email: 'me@example.com' }],
  subject: 'Invoice and prototype',
  receivedAt: '2026-01-01T00:00:00Z',
  preview: 'Here is the invoice',
  hasAttachment: true,
  size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [{ partId: '1', type: 'text/plain' }],
  bodyValues: { '1': { value: 'Here is the invoice.' } },
  attachments: [
    { partId: '2', blobId: 'blob-pdf', name: 'Invoice-2026-089.pdf', type: 'application/pdf', size: 51200, disposition: 'attachment' },
    { partId: '3', blobId: 'blob-zip', name: 'icons.zip', type: 'application/zip', size: 2048, disposition: 'attachment' },
  ],
} as unknown as Email;

const client = new Proxy({ getAccountId: () => 'me' } as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : vi.fn().mockResolvedValue(null)),
}) as unknown as IJMAPClient;

const follows = (a: Element, b: Element) => !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('attachment position in the reader', () => {
  beforeEach(() => {
    useAuthStore.setState({ client } as never);
    useSettingsStore.setState({ markAsReadDelay: -1 });
  });

  it('draws a bar above the body below the header', async () => {
    useSettingsStore.setState({ attachmentPosition: 'below-header' });
    const { container } = render(<EmailViewer email={email} mailboxes={[]} selectedMailbox="inbox" />);
    const body = await screen.findByText('Here is the invoice.');
    const sections = container.querySelectorAll('[data-testid="reader-attachments"]');
    expect(sections).toHaveLength(1);
    expect((sections[0] as HTMLElement).dataset.layout).toBe('bar');
    expect(follows(body, sections[0])).toBe(true);
    expect(screen.queryByTestId('attachments-jump')).toBeNull();
  });

  it('draws the bar, and nothing beside the sender, for the retired beside-sender value', async () => {
    useSettingsStore.setState({ attachmentPosition: 'beside-sender' as never });
    const { container } = render(<EmailViewer email={email} mailboxes={[]} selectedMailbox="inbox" />);
    await screen.findByText('Here is the invoice.');
    expect(container.querySelectorAll('[data-testid="attachment"]')).toHaveLength(2);
    const sections = container.querySelectorAll('[data-testid="reader-attachments"]');
    expect(sections).toHaveLength(1);
    expect((sections[0] as HTMLElement).dataset.layout).toBe('bar');
  });

  it('draws cards after the body, with a jump link in the header', async () => {
    useSettingsStore.setState({ attachmentPosition: 'below-message' });
    const { container } = render(<EmailViewer email={email} mailboxes={[]} selectedMailbox="inbox" />);
    const body = await screen.findByText('Here is the invoice.');
    const sections = container.querySelectorAll('[data-testid="reader-attachments"]');
    expect(sections).toHaveLength(1);
    expect((sections[0] as HTMLElement).dataset.layout).toBe('cards');
    expect(follows(sections[0], body)).toBe(true);
    expect(sections[0].querySelectorAll('[data-testid="attachment"]')).toHaveLength(2);

    const jump = screen.getByTestId('attachments-jump');
    const scrollIntoView = vi.fn();
    sections[0].parentElement!.scrollIntoView = scrollIntoView;
    jump.click();
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
