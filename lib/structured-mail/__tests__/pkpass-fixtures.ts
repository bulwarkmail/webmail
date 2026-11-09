/**
 * Self-written Wallet passes for the .pkpass tests (made-up values, not
 * Apple's or Google's documentation examples), and a jszip builder that
 * packs them the way a real .pkpass is packed.
 */
import JSZip from 'jszip';

export const MAIL_DATE = new Date('2026-11-20T08:00:00Z');

type Json = Record<string, unknown>;

function pass(style: string, styleBody: Json, semantics: Json | null, extra: Json = {}): Json {
  return {
    formatVersion: 1,
    passTypeIdentifier: 'pass.org.example.boarding',
    serialNumber: 'SER-55120',
    teamIdentifier: 'ABCDE12345',
    organizationName: 'Swiss',
    description: 'Boarding pass',
    relevantDate: '2026-12-03T07:05+01:00',
    webServiceURL: 'https://passes.example.org/v1',
    authenticationToken: 'never-used-token-0000',
    barcodes: [{ format: 'PKBarcodeFormatQR', message: 'M1BEISPIEL/JANA', messageEncoding: 'iso-8859-1' }],
    [style]: { primaryFields: [{ key: 'origin', label: 'ZRH', value: 'Zurich' }], ...styleBody },
    ...(semantics ? { semantics } : {}),
    ...extra,
  };
}

export const AIR_SEMANTICS: Json = {
  airlineCode: 'LX',
  flightNumber: 1072,
  flightCode: 'LX1072',
  confirmationNumber: 'PK7Q2Z',
  departureAirportCode: 'ZRH',
  departureAirportName: 'Zurich Airport',
  destinationAirportCode: 'BER',
  destinationAirportName: 'Berlin Brandenburg',
  originalDepartureDate: '2026-12-03T07:40+01:00',
  originalArrivalDate: '2026-12-03T09:05+01:00',
  departureLocationTimeZone: 'Europe/Zurich',
  destinationLocationTimeZone: 'Europe/Berlin',
  passengerName: { givenName: 'Jana', familyName: 'Beispiel' },
  seats: [{ seatRow: '14', seatNumber: 'C' }],
  transitProvider: 'Swiss International Air Lines',
};

export const boardingPass = (semantics: Json | null = AIR_SEMANTICS, transitType = 'PKTransitTypeAir', extra: Json = {}) =>
  pass('boardingPass', { transitType }, semantics, extra);

export const TRAIN_SEMANTICS: Json = {
  confirmationNumber: 'ZUG4471',
  transitProvider: 'Deutsche Bahn',
  vehicleNumber: 'ICE 597',
  departureStationName: 'Hamburg Hbf',
  destinationStationName: 'Köln Hbf',
  originalDepartureDate: '2026-12-05T08:46:00+01:00',
  originalArrivalDate: '2026-12-05T12:50:00+01:00',
  carNumber: '7',
  seats: [{ seatNumber: '45' }],
  passengerName: { givenName: 'Jana', familyName: 'Beispiel' },
};

export const BUS_SEMANTICS: Json = {
  confirmationNumber: 'BUS-80411',
  transitProvider: 'Fernbus Nord',
  departureStationName: 'Bremen ZOB',
  destinationStationName: 'Hannover ZOB',
  currentDepartureDate: '2026-12-06T10:15:00+01:00',
  passengerName: { givenName: 'Ole', familyName: 'Probe' },
};

export const EVENT_SEMANTICS: Json = {
  eventName: 'Kammerkonzert im Turmsaal',
  eventStartDate: '2026-12-12T19:30:00+01:00',
  eventEndDate: '2026-12-12T21:45:00+01:00',
  venueName: 'Turmsaal Hildesheim',
  venueRegionName: 'Hildesheim',
  confirmationNumber: 'TKT-30918',
  attendeeName: 'Jana Beispiel',
};

export const eventTicket = (semantics: Json | null = EVENT_SEMANTICS) => pass('eventTicket', {}, semantics);
export const otherPass = (style: 'storeCard' | 'coupon' | 'generic') => pass(style, {}, { ...EVENT_SEMANTICS, ...AIR_SEMANTICS });

/** A .pkpass archive: pass.json plus the files a real one carries. */
export async function zipPass(passJson: unknown, options: { raw?: string; files?: Record<string, string> } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('pass.json', options.raw ?? JSON.stringify(passJson));
  zip.file('manifest.json', JSON.stringify({ 'pass.json': '0000000000000000000000000000000000000000' }));
  zip.file('signature', 'not a real signature');
  zip.file('icon.png', 'png bytes');
  for (const [name, content] of Object.entries(options.files ?? {})) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
