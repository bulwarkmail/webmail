// The calendar actions sit in the booking cards of both reader surfaces: the
// single viewer and the conversation body. BookingCalendarActions has its own
// tests; here a marker stands in for it, so only the wiring is checked.
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAuthenticationResults } from '@/lib/email-headers';
import type { Email, EmailBodyPart, Mailbox } from '@/lib/jmap/types';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));
vi.mock('../structured-mail/booking-calendar-actions', () => ({
  BookingCalendarActions: ({ booking, email }: { booking: { kind: string; reference?: string }; email: { id: string } }) => (
    <span data-testid="calendar-actions-marker">{`${booking.kind}:${booking.reference}:${email.id}`}</span>
  ),
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { ConversationEmailBody } = await import('../thread-conversation-view');
const { usePolicyStore } = await import('@/stores/policy-store');

const BOOKING = {
  '@context': 'http://schema.org', '@type': 'FoodEstablishmentReservation', reservationNumber: 'T-4410',
  startTime: '2026-11-07T19:30:00+01:00', partySize: 2,
  reservationFor: { '@type': 'Restaurant', name: 'Zur Linde', address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
};
const ORDER = { '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop' };
const PASS = 'mx.example.org; dkim=pass header.d=tables.example; spf=pass smtp.mailfrom=bounce@tables.example; dmarc=pass header.from=tables.example';

function mail(id: string, markup: unknown): Email {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(markup)}</script></head><body><p>See you soon.</p></body></html>`;
  return {
    id, blobId: `b-${id}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Tables', email: 'hello@tables.example' }], to: [{ email: 'me@example.org' }],
    subject: 'Your table', receivedAt: '2026-10-30T09:00:00Z', size: 100, preview: 'See you', hasAttachment: false,
    authenticationResults: parseAuthenticationResults([PASS]), authenticationResultsOnReceipt: true,
    htmlBody: [{ partId: '1', type: 'text/html' } as EmailBodyPart], textBody: [], attachments: [],
    bodyValues: { '1': { value: html, isTruncated: false, isEncodingProblem: false } },
  } as unknown as Email;
}

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const initialPolicy = usePolicyStore.getState();
afterEach(() => usePolicyStore.setState(initialPolicy, true));
usePolicyStore.setState((s) => ({ policy: { ...s.policy, features: { ...s.policy.features, structuredMailEnabled: true } } }));

describe('calendar actions in booking cards', () => {
  it('appear in the single viewer, for the booking and the open message', () => {
    render(<EmailViewer email={mail('v1', BOOKING)} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    const region = screen.getByRole('region', { name: 'region_restaurant' });
    expect(within(region).getByTestId('calendar-actions-marker')).toHaveTextContent('restaurant:T-4410:v1');
  }, 30_000);

  it('appear in the conversation body', () => {
    render(<ConversationEmailBody email={mail('c1', BOOKING)} allowExternal={false} onAllowExternal={() => {}} />);
    const region = screen.getByRole('region', { name: 'region_restaurant' });
    expect(within(region).getByTestId('calendar-actions-marker')).toHaveTextContent('restaurant:T-4410:c1');
  }, 30_000);

  it('never appear on an order card', () => {
    render(<EmailViewer email={mail('v2', ORDER)} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    expect(screen.getByRole('region', { name: 'region_shipment' })).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-actions-marker')).toBeNull();
  }, 30_000);
});
