import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { parseAuthenticationResults } from '@/lib/email-headers';
import { useSettingsStore } from '@/stores/settings-store';

// The verified-brand check mark belongs to the sender's name: right after it,
// not after the address that follows the name on the line or under it.

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

const ADDRESS = 'bestellbestaetigung@brand.example';

const message = {
  id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Brand', email: ADDRESS }], to: [{ name: 'Me', email: 'me@example.com' }],
  subject: 'Your order', receivedAt: '2026-11-09T20:08:00Z', sentAt: '2026-11-09T20:08:00Z', preview: 'Ordered',
  hasAttachment: false, size: 100,
  authenticationResults: parseAuthenticationResults(['mx.example; dmarc=pass header.from=brand.example']),
  authenticationResultsOnReceipt: true,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [],
  bodyValues: { '1': { value: 'Ordered', isTruncated: false } },
} as unknown as Email;

const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('verified-brand check mark placement', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', markAsReadDelay: 0, timeFormat: '24h', senderFavicons: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status: 'verified', organization: 'Brand Inc.', issuer: 'DigiCert' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
  });

  it('sits right after the name in the sender line, before the address', async () => {
    const { container } = render(
      <EmailViewer email={message} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        conversationPane onReply={vi.fn()} onReplyAll={vi.fn()} onForward={vi.fn()} />,
    );
    const line = container.querySelector<HTMLElement>('[data-sender-line]')!;
    expect(line).not.toBeNull();
    const badge = await waitFor(() => {
      const found = line.querySelector('[data-brand-verified]');
      expect(found).not.toBeNull();
      return found!;
    });
    const address = line.querySelector('[data-sender-address]')!;
    expect(address.textContent).toContain(ADDRESS);
    expect(follows(badge, address)).toBe(true);
  });

  it('opens its explanation outside the clipped sender line', async () => {
    const { container } = render(
      <EmailViewer email={message} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        conversationPane onReply={vi.fn()} onReplyAll={vi.fn()} onForward={vi.fn()} />,
    );
    const line = container.querySelector<HTMLElement>('[data-sender-line]')!;
    const badge = await waitFor(() => {
      const found = line.querySelector<HTMLElement>('[data-brand-verified]');
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(badge);
    const explanation = screen.getAllByRole('status').find((el) => el.textContent === 'verified_by')!;
    expect(explanation).toBeDefined();
    expect(line.contains(explanation)).toBe(false);
    expect(badge.getAttribute('aria-controls')).toBe(explanation.id);
    // A press inside the explanation keeps it open; one elsewhere closes it.
    fireEvent.pointerDown(explanation);
    expect(explanation.isConnected).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(explanation.isConnected).toBe(false);
  });

  it('follows the name in the details panel, not the address under it', async () => {
    render(
      <EmailViewer email={message} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        onReply={vi.fn()} onReplyAll={vi.fn()} onForward={vi.fn()} />,
    );
    // The desktop and the mobile header each have the toggle.
    fireEvent.click(screen.getAllByRole('button', { name: /show_details/ })[0]);
    const section = screen.getByText('details.recipients_routing').closest('section')!;
    const badge = await waitFor(() => {
      const found = section.querySelector('[data-brand-verified]');
      expect(found).not.toBeNull();
      return found!;
    });
    const name = within(section).getByRole('button', { name: 'Brand' });
    const address = section.querySelector(`bdi[title="${ADDRESS}"]`)!;
    expect(address).not.toBeNull();
    expect(follows(name, badge)).toBe(true);
    expect(follows(badge, address)).toBe(true);
    // The address still opens the sender's card.
    expect(address.closest('button')).not.toBeNull();
  });
});
