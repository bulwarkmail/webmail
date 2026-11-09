// Booking, parcel and order cards in the reader: the single viewer (desktop
// and Mountain View's open message) and the conversation body (phone thread,
// Mountain View's other expanded messages). A card only for mail the
// receiving server tied to its From domain.
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

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { ConversationEmailBody, ThreadConversationView } = await import('../thread-conversation-view');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const ORDER = {
  '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-77120', merchant: { '@type': 'Organization', name: 'Outdoor Shop' },
  orderStatus: 'http://schema.org/OrderProcessing',
  acceptedOffer: [{ '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Tent', image: 'https://img.shop.example/tent.jpg' } }],
};
const HTML = `<html><head><script type="application/ld+json">${JSON.stringify(ORDER)}</script></head><body><p>Thanks for your order.</p></body></html>`;
const PASS = 'mx.example.org; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';

type Variant = 'trusted' | 'no-authentication-results' | 'not-on-receipt' | 'dkim-fail';

function mail(id: string, variant: Variant = 'trusted', extra: Partial<Email> = {}): Email {
  const ar = variant === 'dkim-fail' ? PASS.replace('dkim=pass', 'dkim=fail').replace('dmarc=pass', 'dmarc=fail') : PASS;
  return {
    id, blobId: `b-${id}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Outdoor Shop', email: 'orders@shop.example' }], to: [{ email: 'me@example.org' }],
    subject: 'Your order', receivedAt: '2026-10-30T09:00:00Z', size: 100, preview: 'Thanks', hasAttachment: false,
    ...(variant === 'no-authentication-results' ? {} : {
      authenticationResults: parseAuthenticationResults([ar]),
      authenticationResultsOnReceipt: variant !== 'not-on-receipt',
    }),
    htmlBody: [{ partId: '1', type: 'text/html' } as EmailBodyPart], textBody: [], attachments: [],
    bodyValues: { '1': { value: HTML, isTruncated: false, isEncodingProblem: false } },
    ...extra,
  } as unknown as Email;
}

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

const initialPolicy = usePolicyStore.getState();
function gate(on: boolean) {
  usePolicyStore.setState((s) => ({ policy: { ...s.policy, features: { ...s.policy.features, structuredMailEnabled: on } } }));
}
const initialSettings = useSettingsStore.getState();
afterEach(() => {
  usePolicyStore.setState(initialPolicy, true);
  useSettingsStore.setState(initialSettings, true);
});

const cardImages = () => cardRegion()?.querySelectorAll('img') ?? [];

const cardRegion = () => screen.queryByRole('region', { name: 'region_shipment' });

describe('cards in the single viewer', () => {
  const viewer = (email: Email) => render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

  it('shows the order card of a verified sender in the notification block', () => {
    gate(true);
    viewer(mail('v1'));
    const region = cardRegion();
    expect(region).not.toBeNull();
    expect(within(region!).getByRole('heading', { name: 'Outdoor Shop' })).toBeInTheDocument();
    expect(region).toHaveTextContent('SO-77120');
    expect(screen.getAllByTestId('structured-mail-cards')).toHaveLength(1);
  }, 30_000);

  it.each<Variant>(['no-authentication-results', 'not-on-receipt', 'dkim-fail'])('shows no card for a forged or unverified mail (%s)', (variant) => {
    gate(true);
    viewer(mail(`v-${variant}`, variant));
    expect(screen.getByText('Your order')).toBeInTheDocument();
    expect(cardRegion()).toBeNull();
  }, 30_000);

  it('loads item images only when the viewer loads remote content', () => {
    gate(true);
    expect(useSettingsStore.getState().externalContentPolicy).toBe('ask');
    const first = viewer(mail('v3'));
    expect(cardImages()).toHaveLength(0);
    first.unmount();
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    viewer(mail('v4'));
    expect(cardImages()).toHaveLength(1);
    expect(cardImages()[0]).toHaveAttribute('src', 'https://img.shop.example/tent.jpg');
  }, 30_000);

  it('shows no card with the admin gate off', () => {
    gate(false);
    viewer(mail('v2'));
    expect(cardRegion()).toBeNull();
  }, 30_000);
});

describe('cards in the conversation body', () => {
  const body = (email: Email, allowExternal = false) => render(
    <ConversationEmailBody email={email} allowExternal={allowExternal} onAllowExternal={() => {}} />,
  );

  it('loads item images only when the message may load remote content', () => {
    gate(true);
    const first = body(mail('c2'));
    expect(cardImages()).toHaveLength(0);
    first.unmount();
    body(mail('c3'), true);
    expect(cardImages()).toHaveLength(1);
  }, 30_000);

  it('loads no item images while mail is shown as plain text', () => {
    gate(true);
    useSettingsStore.setState({ mailViewMode: 'plain' });
    body(mail('c4'), true);
    expect(cardRegion()).not.toBeNull();
    expect(cardImages()).toHaveLength(0);
  }, 30_000);

  it('shows the card of a verified sender above the body', () => {
    gate(true);
    const { container } = body(mail('c1'));
    const region = cardRegion();
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent('SO-77120');
    // Before the body's frame.
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(region!.compareDocumentPosition(iframe!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }, 30_000);

  it.each<Variant>(['no-authentication-results', 'not-on-receipt', 'dkim-fail'])('shows no card for a forged or unverified mail (%s)', (variant) => {
    gate(true);
    body(mail(`c-${variant}`, variant));
    expect(cardRegion()).toBeNull();
  }, 30_000);

  it('gives each expanded message its own card and none to a collapsed one', () => {
    gate(true);
    const newer = mail('t-new');
    const older = mail('t-old', 'trusted', {
      receivedAt: '2026-10-29T09:00:00Z',
      bodyValues: { '1': { value: HTML.replace('SO-77120', 'SO-11111'), isTruncated: false, isEncodingProblem: false } },
    });
    render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails: [newer, older], latestEmail: newer } as never}
        emails={[newer, older]}
        onBack={() => {}}
      />,
    );
    // The newest message is expanded, the older (read) one collapsed.
    const regions = screen.getAllByRole('region', { name: 'region_shipment' });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent('SO-77120');
    expect(screen.queryByText('SO-11111')).toBeNull();
  }, 30_000);
});
