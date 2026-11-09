/**
 * Travel mail with booking markup: Tagus Air's confirmation of the evening
 * flight home from Lisbon on the last day of Infra Summit (days 9 to 12 in
 * fixtures/calendars.ts; the out-of-office in fixtures/vacation.ts runs
 * until that evening). The HTML carries a schema.org FlightReservation as
 * JSON-LD and the receiving server verified the sender, so the viewer shows
 * a booking card above the message (lib/structured-mail).
 */
import type { Email } from '@/lib/jmap/types';
import { demoISODate } from '../demo-utils';
import { at, authPass, dayLabel, mail } from './mail';
import { MB } from './mailboxes';
import { NORA } from './people';

export const FLIGHT_EMAIL_ID = 'demo-email-tagus-air';
export const FLIGHT_SENDER = { name: 'Tagus Air', email: 'booking@tagusair.example' };
export const FLIGHT_REFERENCE = 'K4TQ9M';
/** The last summit day, relative to today. */
export const FLIGHT_DAY = 12;

const SITE = 'https://www.tagusair.example';

/** What the airline's mail system puts into the HTML: a FlightReservation in local airport time. */
export function createFlightReservation(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FlightReservation',
    reservationNumber: FLIGHT_REFERENCE,
    reservationStatus: 'https://schema.org/ReservationConfirmed',
    underName: { '@type': 'Person', name: NORA.name },
    reservationFor: {
      '@type': 'Flight',
      flightNumber: '482',
      airline: { '@type': 'Airline', name: 'Tagus Air', iataCode: 'TQ' },
      departureAirport: { '@type': 'Airport', name: 'Lisbon Humberto Delgado', iataCode: 'LIS' },
      departureTime: demoISODate(FLIGHT_DAY, 17, 10),
      arrivalAirport: { '@type': 'Airport', name: 'Berlin Brandenburg', iataCode: 'BER' },
      arrivalTime: demoISODate(FLIGHT_DAY, 21, 35),
    },
    airplaneSeat: '7C',
    checkinUrl: `${SITE}/check-in?pnr=${FLIGHT_REFERENCE}`,
    modifyReservationUrl: `${SITE}/my-trips/${FLIGHT_REFERENCE}`,
  };
}

export function createDemoTravelEmails(): Email[] {
  const day = dayLabel(FLIGHT_DAY);
  const row = (label: string, value: string, first = false) => {
    const border = first ? '' : 'border-top:1px solid #f0f0f0;';
    return `<tr><td style="padding:10px 0;color:#666;${border}">${label}</td><td style="padding:10px 0;text-align:right;${border}">${value}</td></tr>`;
  };
  const html = `<script type="application/ld+json">${JSON.stringify(createFlightReservation())}</script>`
    + '<div style="max-width:560px;margin:0 auto;font-family:-apple-system,sans-serif">'
    + '<p style="font-size:18px;font-weight:700;color:#0b5f8a;margin:0 0 16px">Tagus Air</p>'
    + '<h1 style="font-size:20px;margin:0 0 4px">Your booking is confirmed</h1>'
    + `<p style="color:#555;margin:0 0 20px">Lisbon (LIS) to Berlin (BER), ${day}</p>`
    + '<table style="width:100%;border-top:1px solid #eee">'
    + row('Flight', 'TQ 482', true)
    + row('Departs', `${day}, 17:10, Lisbon (LIS)`)
    + row('Arrives', `${day}, 21:35, Berlin (BER)`)
    + row('Passenger', `${NORA.name}, seat 7C, Economy`)
    + row('Booking reference', `<strong>${FLIGHT_REFERENCE}</strong>`)
    + '</table>'
    + `<p style="margin:24px 0"><a href="${SITE}/check-in?pnr=${FLIGHT_REFERENCE}" style="background:#0b5f8a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Check in online</a></p>`
    + '<p style="color:#666;font-size:13px">Online check-in opens 24 hours before departure. One cabin bag up to 8 kg is included.</p>'
    + '</div>';
  return [
    {
      ...mail({
        id: FLIGHT_EMAIL_ID, mailbox: MB.inbox, date: at(1, 18, 20),
        from: FLIGHT_SENDER,
        subject: `Booking confirmed ${FLIGHT_REFERENCE}: Lisbon to Berlin`,
        text: `Your booking is confirmed.\n\nTQ 482 · ${day} · Lisbon (LIS) 17:10 to Berlin (BER) 21:35\n\nPassenger: ${NORA.name} · Seat 7C · Economy\nBooking reference: ${FLIGHT_REFERENCE}\n\nCheck in online from 24 hours before departure: ${SITE}/check-in?pnr=${FLIGHT_REFERENCE}\n\nOne cabin bag up to 8 kg is included.\n\nTagus Air`,
        html,
        keywords: ['$label:travel'],
        headers: authPass('tagusair.example'),
      }),
      // The Authentication-Results header came from the receiving MX, not a
      // submission hop; a real fetch reads that from the Received order.
      authenticationResultsOnReceipt: true,
    },
  ];
}
