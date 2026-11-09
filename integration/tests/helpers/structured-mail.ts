/**
 * Booking, parcel and order mails for the structured-mail spec. They are put
 * into the mailbox with blob upload + Email/import (SMTP on the shared test
 * servers doesn't work), so the Authentication-Results each mail needs is
 * written at the top of the raw message, below a Received line: Email/import
 * adds no header of its own, and Bulwark only believes an
 * Authentication-Results header that a Received header sits above.
 */
import { JMAP_URL } from './config';

export const SUBJECT_PREFIX = 'sm-e2e';
export const AIRLINE_DOMAIN = 'air.example.com';
export const SHOP_DOMAIN = 'shop.example.com';

const pad = (n: number) => String(n).padStart(2, '0');

/** Wall clock of an instant in a zone: { date: 'YYYY-MM-DD', time: 'HH:mm', offset: '+01:00' }. */
export function wallClock(utcMs: number, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const offsetMinutes = Math.round((Date.parse(`${date}T${time}:00Z`) - Math.floor(utcMs / 60000) * 60000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return { date, time, offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}

/** The test flight: LH 400 FRA → JFK, 8 h 50 min, about a month from now. */
export function testFlight(departureLocal: string) {
  const day = new Date(Date.now() + 30 * 86_400_000);
  const date = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
  // Find the instant whose Berlin wall clock is `date departureLocal`.
  const guess = Date.parse(`${date}T${departureLocal}:00Z`);
  const offset = wallClock(guess, 'Europe/Berlin').offset;
  const depUtc = Date.parse(`${date}T${departureLocal}:00${offset}`);
  const arrUtc = depUtc + (8 * 60 + 50) * 60_000;
  const dep = wallClock(depUtc, 'Europe/Berlin');
  const arr = wallClock(arrUtc, 'America/New_York');
  return {
    depUtc, arrUtc, dep, arr,
    departureTime: `${dep.date}T${dep.time}:00${dep.offset}`,
    arrivalTime: `${arr.date}T${arr.time}:00${arr.offset}`,
  };
}

function flightJsonLd(departureLocal: string, status: 'ReservationConfirmed' | 'ReservationCancelled') {
  const f = testFlight(departureLocal);
  return {
    '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'E2EQ7K',
    reservationStatus: `http://schema.org/${status}`, underName: { '@type': 'Person', name: 'Erika Mustermann' },
    airplaneSeat: '12A', checkinUrl: `https://www.${AIRLINE_DOMAIN}/checkin?pnr=E2EQ7K`,
    reservationFor: {
      '@type': 'Flight', flightNumber: '400', airline: { '@type': 'Airline', name: 'Lufthansa', iataCode: 'LH' },
      departureAirport: { '@type': 'Airport', name: 'Frankfurt Airport', iataCode: 'FRA' }, departureTime: f.departureTime,
      arrivalAirport: { '@type': 'Airport', name: 'John F. Kennedy International Airport', iataCode: 'JFK' }, arrivalTime: f.arrivalTime,
    },
  };
}

const passing = (domain: string) =>
  `Authentication-Results: mx.example.org; dkim=pass header.d=${domain} header.s=s1; spf=pass smtp.mailfrom=bounce@${domain}; dmarc=pass header.from=${domain}`;
const failing = (domain: string) =>
  `Authentication-Results: mx.example.org; dkim=fail header.d=${domain}; spf=fail smtp.mailfrom=${domain}; dmarc=fail header.from=${domain}`;
const received = (domain: string) =>
  `Received: from mail.${domain} (mail.${domain} [192.0.2.10]) by mx.example.org (Stalwart SMTP) with ESMTPS id e2e`;

interface MailSpec {
  subject: string;
  from: string;
  to: string;
  topHeaders: string[];
  html: string;
  text: string;
}

function raw(spec: MailSpec): string {
  const boundary = `sm-${Math.random().toString(36).slice(2)}`;
  const id = `${Math.random().toString(36).slice(2)}@${spec.from.split('@').pop()!.replace('>', '')}`;
  return [
    ...spec.topHeaders,
    `From: ${spec.from}`, `To: ${spec.to}`, `Subject: ${spec.subject}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${id}>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', spec.text, '',
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', spec.html, '',
    `--${boundary}--`, '',
  ].join('\r\n');
}

const page = (markup: unknown | null, text: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8">${markup ? `<script type="application/ld+json">${JSON.stringify(markup)}</script>` : ''}</head>`
  + `<body><p>${text}</p></body></html>`;

export type FixtureName = 'flight' | 'flightUpdate' | 'flightCancel' | 'forged' | 'localForged' | 'parcel' | 'order' | 'plain';

/** Raw messages by name, addressed to `to`; subjects are unique per run via `tag`. */
export function fixtureMails(to: string, tag: string): Record<FixtureName, { subject: string; raw: string }> {
  const airline = `Example Air <bookings@${AIRLINE_DOMAIN}>`;
  const shop = `Outdoor Shop <orders@${SHOP_DOMAIN}>`;
  const order = {
    '@context': 'http://schema.org', '@type': 'Order', merchant: { '@type': 'Organization', name: 'Outdoor Shop' },
    orderNumber: 'SO-E2E-1', orderStatus: 'http://schema.org/OrderProcessing', price: '129.90', priceCurrency: 'EUR',
    acceptedOffer: { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Wanderschuhe' }, eligibleQuantity: { value: '1' } },
    url: `https://www.${SHOP_DOMAIN}/account/orders/SO-E2E-1`,
  };
  const parcel = {
    '@context': 'http://schema.org', '@type': 'ParcelDelivery', carrier: { '@type': 'Organization', name: 'DHL' },
    trackingNumber: '00340434169999000001', trackingUrl: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434169999000001',
    itemShipped: { '@type': 'Product', name: 'Wanderschuhe' },
    partOfOrder: { '@type': 'Order', orderNumber: 'SO-E2E-2', merchant: { '@type': 'Organization', name: 'Outdoor Shop' }, orderStatus: 'http://schema.org/OrderInTransit' },
  };
  const mails: Record<FixtureName, Omit<MailSpec, 'text'>> = {
    flight: { subject: 'Flight booking LH 400', from: airline, to, topHeaders: [received(AIRLINE_DOMAIN), passing(AIRLINE_DOMAIN)], html: page(flightJsonLd('10:15', 'ReservationConfirmed'), 'Your booking E2EQ7K is confirmed.') },
    flightUpdate: { subject: 'Schedule change LH 400', from: airline, to, topHeaders: [received(AIRLINE_DOMAIN), passing(AIRLINE_DOMAIN)], html: page(flightJsonLd('11:00', 'ReservationConfirmed'), 'Your flight now leaves at 11:00.') },
    flightCancel: { subject: 'Flight cancelled LH 400', from: airline, to, topHeaders: [received(AIRLINE_DOMAIN), passing(AIRLINE_DOMAIN)], html: page(flightJsonLd('11:00', 'ReservationCancelled'), 'Your flight was cancelled.') },
    forged: { subject: 'Forged flight booking', from: airline, to, topHeaders: [received(AIRLINE_DOMAIN), failing(AIRLINE_DOMAIN)], html: page(flightJsonLd('10:15', 'ReservationConfirmed'), 'Your booking E2EQ7K is confirmed.') },
    // As a signed-in local user can submit it: passing header, no Received above it.
    localForged: { subject: 'Locally forged flight booking', from: airline, to, topHeaders: [passing(AIRLINE_DOMAIN)], html: page(flightJsonLd('10:15', 'ReservationConfirmed'), 'Your booking E2EQ7K is confirmed.') },
    parcel: { subject: 'Your parcel is on its way', from: shop, to, topHeaders: [received(SHOP_DOMAIN), passing(SHOP_DOMAIN)], html: page(parcel, 'Your order SO-E2E-2 has shipped.') },
    order: { subject: 'Your order SO-E2E-1', from: shop, to, topHeaders: [received(SHOP_DOMAIN), passing(SHOP_DOMAIN)], html: page(order, 'Thanks for your order.') },
    plain: { subject: 'Your order without markup', from: shop, to, topHeaders: [received(SHOP_DOMAIN), passing(SHOP_DOMAIN)], html: page(null, 'Thanks for your order.') },
  };
  return Object.fromEntries(Object.entries(mails).map(([name, spec]) => {
    const subject = `${SUBJECT_PREFIX} ${tag} ${spec.subject}`;
    const text = /<p>(.*?)<\/p>/.exec(spec.html)?.[1] ?? spec.subject;
    return [name, { subject, raw: raw({ ...spec, subject, text }) }];
  })) as Record<FixtureName, { subject: string; raw: string }>;
}

/** Upload a raw message and Email/import it into the Inbox. Returns the email id. */
export async function importMail(
  client: { request: (calls: [string, Record<string, unknown>, string][], using?: string[]) => Promise<any>; accountId: string },
  auth: string,
  rawMessage: string,
  inboxId: string,
): Promise<string> {
  const upload = await fetch(`${JMAP_URL}/jmap/upload/${client.accountId}/`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'message/rfc822' }, body: rawMessage,
  });
  if (!upload.ok) throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  const { blobId } = await upload.json();
  const r = await client.request([['Email/import', {
    accountId: client.accountId, emails: { m: { blobId, mailboxIds: { [inboxId]: true }, keywords: {} } },
  }, '0']]);
  const id = r.methodResponses[0][1].created?.m?.id;
  if (!id) throw new Error(`Email/import failed: ${JSON.stringify(r.methodResponses[0][1])}`);
  return id;
}
