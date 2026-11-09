/**
 * Structured mail: read the schema.org markup that airlines, hotels, shops
 * and carriers put into their HTML mail, and turn it into cards. Plain
 * TypeScript; the only DOM dependency is the HTML parser, which a caller
 * without DOMParser (the native app) passes in.
 *
 *   const cards = readStructuredMail(html, { mailDate });
 *   const shown = needsAirportZones(cards)
 *     ? resolveCards(cards, await loadAirportZones())
 *     : resolveCards(cards);
 */
import { extractStructuredData } from './extract';
import { mergeCandidates } from './merge';
import { hasReservation, normalizeItems } from './normalize';
import type { StructuredCard } from './types';
import { validateCard } from './validate';

export interface ReadOptions {
  /** When the mail was sent (else received): bookings far from it are doubtful. */
  mailDate: Date;
  parseHtml?: (html: string) => Document;
}

export interface DetailedRead {
  /** Validated cards, merged to one per booking, zones not yet resolved. */
  cards: StructuredCard[];
  /**
   * Whether the markup holds any reservation, valid or rejected. Such a mail
   * is read from its markup alone: a pass must not bring back a booking the
   * markup rejected or cancelled, nor add a second card for it.
   */
  hadBookingMarkup: boolean;
}

/** readStructuredMail, plus whether the markup described a booking at all. */
export function readStructuredMailDetailed(html: string, options: ReadOptions): DetailedRead {
  const extracted = extractStructuredData(html, options.parseHtml);
  const cards = normalizeItems(extracted);
  return {
    cards: mergeCandidates(cards.map((card) => validateCard(card, options.mailDate))),
    hadBookingMarkup: hasReservation(extracted),
  };
}

/**
 * Cards from one HTML body: validated and merged to one card per booking,
 * with zones not yet resolved (resolveCards).
 */
export function readStructuredMail(html: string, options: ReadOptions): StructuredCard[] {
  return readStructuredMailDetailed(html, options).cards;
}

export { extractStructuredData, mayContainStructuredData } from './extract';
export { normalizeItems } from './normalize';
export { validateCard } from './validate';
export { mergeCandidates } from './merge';
export { needsAirportZones, resolveCards } from './resolve';
export { loadAirportZones } from './time-zones';
export * from './types';
