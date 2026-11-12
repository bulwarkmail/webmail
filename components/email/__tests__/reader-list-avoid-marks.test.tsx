// The parts of the reader that tell the user whose mail this is and what the app vouches for carry
// `data-plugin-list-avoid`, so a list a plugin frame asks for never covers them
// (components/plugins/plugin-iframe-slot.tsx): the subject, the sender line with its avatar, the
// recipients and "Show details", the details' recipients and authentication rows, the app's own
// warning and phishing banners, and the notices and cards block. The message body is not one of
// them, nor the toolbar.
import { fireEvent, render, screen } from '@testing-library/react';
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
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer, MvConversationRun } = await import('../email-viewer');
const { ThreadConversationView } = await import('../thread-conversation-view');
const { usePolicyStore } = await import('@/stores/policy-store');

const ORDER = {
  '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-77120', merchant: { '@type': 'Organization', name: 'Outdoor Shop' },
  orderStatus: 'http://schema.org/OrderProcessing',
};
const HTML = `<html><head><script type="application/ld+json">${JSON.stringify(ORDER)}</script></head><body><p>Thanks for your order.</p></body></html>`;
const PASS = 'mx.example.org; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';
const FAIL = PASS.replace('dkim=pass', 'dkim=fail').replace('dmarc=pass', 'dmarc=fail');

function mail(id: string, extra: Partial<Email> = {}, ar = PASS): Email {
  return {
    id, blobId: `b-${id}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Outdoor Shop', email: 'orders@shop.example' }], to: [{ name: 'Me', email: 'me@example.org' }],
    subject: 'Your order', receivedAt: '2026-10-30T09:00:00Z', sentAt: '2026-10-30T08:59:00Z', size: 100, preview: 'Thanks', hasAttachment: false,
    authenticationResults: parseAuthenticationResults([ar]), authenticationResultsOnReceipt: true, spamScore: 0.4,
    htmlBody: [{ partId: '1', type: 'text/html' } as EmailBodyPart], textBody: [], attachments: [],
    bodyValues: { '1': { value: HTML, isTruncated: false, isEncodingProblem: false } },
    ...extra,
  } as unknown as Email;
}

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const initialPolicy = usePolicyStore.getState();
afterEach(() => usePolicyStore.setState(initialPolicy, true));
function structuredMail(on: boolean) {
  usePolicyStore.setState((s) => ({ policy: { ...s.policy, features: { ...s.policy.features, structuredMailEnabled: on } } }));
}

const marked = (el: Element | null) => !!el?.closest('[data-plugin-list-avoid]');
const viewer = (email: Email) => render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);

describe('the reader\'s parts a plugin list never covers', () => {
  it('marks the subject, the sender lines with their avatars, and "Show details"', () => {
    const { container } = viewer(mail('m1'));
    expect(marked(screen.getByRole('heading', { name: 'Your order' }))).toBe(true);
    // The desktop and the phone sender line: the name, and the avatar's button before it.
    const names = screen.getAllByRole('button', { name: 'Outdoor Shop' });
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(marked(name)).toBe(true);
    const avatars = container.querySelectorAll('button[title="orders@shop.example"]');
    expect(avatars.length).toBeGreaterThan(0);
    for (const avatar of avatars) expect(marked(avatar)).toBe(true);
    const toggles = screen.getAllByRole('button', { name: /show_details/ });
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) expect(marked(toggle)).toBe(true);
  }, 30_000);

  it('marks the details\' recipients and authentication rows', () => {
    viewer(mail('m2'));
    fireEvent.click(screen.getAllByRole('button', { name: /show_details/ })[0]);
    const recipients = screen.getByText('details.recipients_routing').closest('section')!;
    expect(marked(recipients.querySelector('dl'))).toBe(true);
    expect(marked(screen.getByText('DKIM'))).toBe(true);
    expect(marked(screen.getByText('authentication.spam_score'))).toBe(true);
  }, 30_000);

  it('marks the app\'s warning about a sender its checks don\'t back', () => {
    viewer(mail('m3', {}, FAIL));
    expect(marked(screen.getByTestId('sender-check-warning'))).toBe(true);
  }, 30_000);

  it('marks the phishing banner', () => {
    viewer(mail('m4', { keywords: { $seen: true, $phishing: true } }));
    expect(marked(screen.getByTestId('phishing-mark-banner'))).toBe(true);
  }, 30_000);

  it('marks the notices block with the booking and order cards', () => {
    structuredMail(true);
    viewer(mail('m5'));
    expect(marked(screen.getByTestId('structured-mail-cards'))).toBe(true);
    expect(marked(screen.getByRole('region', { name: 'region_shipment' }))).toBe(true);
  }, 30_000);

  // Not trust parts: a list may still lie over the body and the toolbar.
  it('leaves the message body and the toolbar unmarked', () => {
    const { container } = viewer(mail('m6'));
    expect(container.querySelector('[data-reader-body]')).not.toBeNull();
    expect(marked(container.querySelector('[data-reader-body]'))).toBe(false);
    expect(marked(screen.getAllByRole('button', { name: /^reply$/i })[0])).toBe(false);
  }, 30_000);
});

describe('the conversation views', () => {
  it('marks the phone thread\'s header and each message\'s sender line', () => {
    const newer = mail('t-new');
    const older = mail('t-old', { receivedAt: '2026-10-29T09:00:00Z' });
    render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails: [newer, older], latestEmail: newer } as never}
        emails={[newer, older]}
        onBack={() => {}}
      />,
    );
    expect(marked(screen.getByRole('heading', { name: 'Your order' }))).toBe(true);
    const senders = document.querySelectorAll('[data-conversation-sender]');
    expect(senders.length).toBe(2);
    for (const sender of senders) expect(marked(sender)).toBe(true);
  }, 30_000);

  it('marks the folded messages of a Mountain View conversation', () => {
    render(<MvConversationRun emails={[mail('f1'), mail('f2', { receivedAt: '2026-10-29T09:00:00Z' })]} onOpen={() => {}} timeFormat="24h" />);
    const cards = document.querySelectorAll('[data-mv-conversation-card]');
    expect(cards.length).toBe(2);
    for (const card of cards) expect(marked(card)).toBe(true);
  }, 30_000);
});
