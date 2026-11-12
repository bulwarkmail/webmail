import { renderHook, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keys with their parameters, so a test can see the facts that go into a string.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === 'route') return `${params!.from} to ${params!.to}`;
    return params ? `${key}${JSON.stringify(params)}` : key;
  },
  useLocale: () => 'en',
}));

import expectedCards from '@/lib/structured-mail/__tests__/fixtures/expected-cards.json';
import { parseAuthenticationResults } from '@/lib/email-headers';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import type { LodgingBooking, Shipment, StructuredCard, TransportBooking } from '@/lib/structured-mail/types';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { StructuredMailCards } from '../structured-mail-cards';
import { useStructuredMail } from '../use-structured-mail';

// A booking card is the sender's word in the app's own look. It says whose domain the mail server
// verified, marks a button that leads outside that domain, and shows no brand text that names
// another domain. A mail whose sender is not verified on receipt gets no card at all.

const fixtures = expectedCards as unknown as Record<string, StructuredCard[]>;
const card = <T extends StructuredCard = StructuredCard>(id: string) => structuredClone(fixtures[id][0]) as T;
const link = (url: string) => ({ url, host: new URL(url).hostname.replace(/^www\./, '') });

/** A flight from orders@shop.example: check-in on shop.example, manage on www.shop.example, ticket elsewhere. */
function shopFlight(): TransportBooking {
  const flight = card<TransportBooking>('flight-two-passengers-two-legs');
  flight.provider = 'Shop Air';
  flight.links = {
    checkin: link('https://shop.example/checkin'),
    manage: link('https://www.shop.example/manage'),
    ticket: link('https://tickets.other-host.example/t/1'),
  };
  return flight;
}

const initialSettings = useSettingsStore.getState();
beforeEach(() => {
  useSettingsStore.setState({ timeFormat: '24h', timeZone: 'Europe/Berlin' });
});
afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
});

function show(cards: StructuredCard[], from: string) {
  return render(<StructuredMailCards cards={cards} email={{ id: 'm1', from: [{ email: from }] }} allowRemoteImages={false} />);
}

const linkByLabel = (label: string) => screen.getAllByTestId('structured-mail-link').find((el) => el.textContent?.startsWith(label))!;
const outside = (el: HTMLElement) => within(el).queryByTestId('structured-mail-outside-link') !== null;

describe('a booking card from orders@shop.example', () => {
  it('names the verified domain in its heading and marks only the button that leads elsewhere', () => {
    show([shopFlight()], 'orders@shop.example');
    const region = screen.getByRole('region', { name: 'region_flight' });
    expect(within(region).getByTestId('structured-mail-sender-domain')).toHaveTextContent('card_sender{"domain":"shop.example"}');
    expect(region).toHaveTextContent('kind_flight · Shop Air · card_sender');
    expect(outside(linkByLabel('link_check_in'))).toBe(false);
    expect(outside(linkByLabel('link_manage'))).toBe(false);
    const ticket = linkByLabel('link_ticket');
    expect(outside(ticket)).toBe(true);
    expect(ticket).toHaveTextContent('tickets.other-host.example');
    expect(ticket.getAttribute('title')).toBe('outside_link_title{"host":"tickets.other-host.example","domain":"shop.example"}');
  });

  it('keeps the button of a sibling under the same registrable domain, and marks look-alikes', () => {
    const flight = shopFlight();
    flight.links = {
      checkin: link('https://checkin.shop.example/x'),
      manage: link('https://shop.example.evil-host.example/x'),
      ticket: link('https://evilshop.example/x'),
    };
    show([flight], 'news@mail.shop.example');
    expect(screen.getByTestId('structured-mail-sender-domain')).toHaveTextContent('"domain":"mail.shop.example"');
    expect(outside(linkByLabel('link_check_in'))).toBe(false);
    expect(outside(linkByLabel('link_manage'))).toBe(true);
    expect(outside(linkByLabel('link_ticket'))).toBe(true);
  });

  it('compares an internationalised domain in its ASCII form', () => {
    const flight = shopFlight();
    flight.links = { checkin: link('https://xn--bcher-kva.example/checkin'), manage: link('https://bücher.example/manage') };
    show([flight], 'info@Bücher.example');
    expect(screen.getByTestId('structured-mail-sender-domain')).toHaveTextContent('"domain":"xn--bcher-kva.example"');
    expect(outside(linkByLabel('link_check_in'))).toBe(false);
    expect(outside(linkByLabel('link_manage'))).toBe(false);
  });

  it('shows no button for a target without a web host (tel:, mailto:)', () => {
    const flight = shopFlight();
    flight.links = { checkin: { url: 'tel:+4930123456', host: '' }, manage: { url: 'mailto:help@other-host.example', host: 'other-host.example' } };
    show([flight], 'orders@shop.example');
    expect(screen.queryAllByTestId('structured-mail-link')).toHaveLength(0);
  });

  it('marks the outside buttons of a card read from a Wallet pass the same way', () => {
    const fromPass = { ...shopFlight(), source: 'pkpass' } as TransportBooking;
    show([fromPass], 'orders@shop.example');
    expect(outside(linkByLabel('link_ticket'))).toBe(true);
    expect(outside(linkByLabel('link_check_in'))).toBe(false);
  });

  it('marks a carrier tracking page and keeps the shop order page in a shipment card', () => {
    const order = card<Shipment>('order-and-parcel');
    order.orderUrl = link('https://www.shop.example/orders/1');
    show([order], 'orders@shop.example');
    const region = screen.getByRole('region', { name: 'region_shipment' });
    expect(within(region).getByTestId('structured-mail-sender-domain')).toHaveTextContent('"domain":"shop.example"');
    expect(outside(linkByLabel('link_view_order'))).toBe(false);
    expect(outside(linkByLabel('link_track'))).toBe(true);
  });
});

describe('brand text in a card', () => {
  it('cannot name a domain other than the verified sender\'s', () => {
    const flight = shopFlight();
    flight.provider = 'Bigbank.example Travel';
    const hotel = card<LodgingBooking>('graph-hotel');
    hotel.name = 'Account review at bigbank.example';
    hotel.provider = 'www.bigbank.example';
    const order = card<Shipment>('order-and-parcel');
    order.merchant = 'bigbank.example';
    order.parcels = order.parcels.map((p) => ({ ...p, carrier: 'Track at bigbank.example' }));
    show([flight, hotel, order], 'orders@shop.example');
    const text = screen.getByTestId('structured-mail-cards').textContent ?? '';
    expect(text.toLowerCase()).not.toContain('bigbank.example');
    // The card falls back to what it is.
    expect(screen.getByRole('region', { name: 'region_flight' })).toHaveTextContent('kind_flight · card_sender');
    expect(within(screen.getByRole('region', { name: 'region_lodging' })).getByRole('heading')).toHaveTextContent('kind_lodging');
    expect(within(screen.getByRole('region', { name: 'region_shipment' })).getByRole('heading')).toHaveTextContent('kind_order');
  });

  it('keeps brand text that names the sender\'s own domain, or none', () => {
    const flight = shopFlight();
    flight.provider = 'Shop.example Air';
    const hotel = card<LodgingBooking>('graph-hotel');
    show([flight, hotel], 'orders@shop.example');
    expect(screen.getByRole('region', { name: 'region_flight' })).toHaveTextContent('kind_flight · Shop.example Air');
    expect(within(screen.getByRole('region', { name: 'region_lodging' })).getByRole('heading')).toHaveTextContent('Hotel Am Markt');
  });
});

describe('a mail whose sender is not verified on receipt', () => {
  const PASS = 'mx.example.org; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';
  const ORDER = `<script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop' })}</script>`;
  const mail = (extra: Partial<Email>) => ({
    id: 'm', threadId: 't', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '2026-10-30T09:00:00Z', subject: 'Order',
    from: [{ email: 'orders@shop.example' }], authenticationResults: parseAuthenticationResults([PASS]),
    htmlBody: [{ partId: '1', type: 'text/html' } as EmailBodyPart],
    bodyValues: { '1': { value: `<html><head>${ORDER}</head><body></body></html>`, isTruncated: false, isEncodingProblem: false } },
    ...extra,
  }) as unknown as Email;
  const initialPolicy = usePolicyStore.getState();
  beforeEach(() => {
    usePolicyStore.setState((state) => ({ policy: { ...state.policy, features: { ...state.policy.features, structuredMailEnabled: true } } }));
  });
  afterEach(() => {
    usePolicyStore.setState(initialPolicy, true);
  });

  it('gets no card when nothing shows its results were written on receipt', () => {
    // As a list row or a search result carries it: results, no flag, no headers.
    expect(renderHook(() => useStructuredMail(mail({}))).result.current).toEqual([]);
    expect(renderHook(() => useStructuredMail(mail({ authenticationResultsOnReceipt: false }))).result.current).toEqual([]);
    // Control: the same mail opened in full.
    expect(renderHook(() => useStructuredMail(mail({ authenticationResultsOnReceipt: true }))).result.current).toHaveLength(1);
  });
});
