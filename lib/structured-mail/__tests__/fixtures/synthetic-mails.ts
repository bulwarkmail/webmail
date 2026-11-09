/**
 * Self-written fixtures, modelled on Google's markup reference and on the
 * kinds of broken input KItinerary's tests cover (written from scratch, not
 * copied). Booking references and names are made up. `expected` lives in
 * structured-mail-fixtures.test.ts.
 */

export interface MailFixture {
  id: string;
  sender: string;
  source: 'real' | 'synthetic';
  mailDate: string;
  html: string;
}

const MAIL_DATE = '2026-10-30T09:00:00Z';
const page = (head: string, body = '') => `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body><p>Thank you for your booking.</p>${body}</body></html>`;
const script = (text: string) => `<script type="application/ld+json">${text}</script>`;
const ld = (value: unknown) => script(JSON.stringify(value));
const C = 'http://schema.org';

const person = (name: string) => ({ '@type': 'Person', name });
const airport = (name: string, iataCode: string) => ({ '@type': 'Airport', name, iataCode });

function flightRes(o: {
  ref: string; name: string; seat?: string; airline?: [string, string]; number: string;
  from: [string, string]; dep: string; to: [string, string]; arr: string; status?: string; checkin?: string;
}) {
  return {
    '@context': C, '@type': 'FlightReservation', reservationNumber: o.ref,
    reservationStatus: `http://schema.org/${o.status ?? 'ReservationConfirmed'}`,
    underName: person(o.name),
    ...(o.seat ? { airplaneSeat: o.seat } : {}),
    ...(o.checkin ? { checkinUrl: o.checkin } : {}),
    reservationFor: {
      '@type': 'Flight', flightNumber: o.number,
      airline: { '@type': 'Airline', name: (o.airline ?? ['Lufthansa', 'LH'])[0], iataCode: (o.airline ?? ['Lufthansa', 'LH'])[1] },
      departureAirport: airport(...o.from), departureTime: o.dep,
      arrivalAirport: airport(...o.to), arrivalTime: o.arr,
    },
  };
}

const fra: [string, string] = ['Frankfurt Airport', 'FRA'];
const jfk: [string, string] = ['John F. Kennedy International Airport', 'JFK'];
const out1 = { number: '400', from: fra, dep: '2026-12-01T10:15:00+01:00', to: jfk, arr: '2026-12-01T13:05:00-05:00' };
const back1 = { number: '401', from: jfk, dep: '2026-12-08T17:30:00-05:00', to: fra, arr: '2026-12-09T07:20:00+01:00' };

const eurowingsLegs = [
  flightRes({ ref: 'EW7Q2K', name: 'Erika Mustermann', airline: ['Eurowings', 'EW'], number: 'EW582', from: ['Köln/Bonn', 'CGN'], dep: '2026-11-20T06:40:00+01:00', to: ['Palma de Mallorca', 'PMI'], arr: '2026-11-20T09:05:00+01:00', seat: '3A' }),
  flightRes({ ref: 'EW7Q2K', name: 'Erika Mustermann', airline: ['Eurowings', 'EW'], number: 'EW583', from: ['Palma de Mallorca', 'PMI'], dep: '2026-11-27T10:00:00+01:00', to: ['Köln/Bonn', 'CGN'], arr: '2026-11-27T12:25:00+01:00', seat: '14F' }),
];

const voloteaPax = ['Erika Mustermann', 'Max Mustermann'].map((name, i) => flightRes({
  ref: 'V0L8TA', name, airline: ['Volotea', 'V7'], number: '1520', seat: `1${i}C`,
  from: ['Venezia', 'VCE'], dep: '2026-12-12T14:10:00+01:00', to: ['Nantes', 'NTE'], arr: '2026-12-12T16:15:00+01:00',
}));

const hotel = {
  '@context': C, '@type': 'LodgingReservation', reservationNumber: 'HB-58213',
  reservationStatus: 'http://schema.org/Confirmed', underName: person('Erika Mustermann'),
  reservationFor: {
    '@type': 'Hotel', name: 'Hotel Am Markt', telephone: '+49 30 1234567',
    address: { '@type': 'PostalAddress', streetAddress: 'Marktplatz 1', addressLocality: 'Berlin', postalCode: '10178', addressCountry: 'DE' },
  },
  checkinDate: '2026-12-04T15:00:00+01:00', checkoutDate: '2026-12-06T11:00:00+01:00',
  modifyReservationUrl: 'https://www.hotel-booking.example.com/manage/HB-58213',
};

const microdataFlight = (o: { ref: string; name: string; number: string; code: string; airline: string; from: [string, string]; dep: string; to: [string, string]; arr?: string }) => `
<div itemscope itemtype="http://schema.org/FlightReservation">
  <meta itemprop="reservationNumber" content="${o.ref}">
  <link itemprop="reservationStatus" href="http://schema.org/Confirmed">
  <div itemprop="underName" itemscope itemtype="http://schema.org/Person"><meta itemprop="name" content="${o.name}"></div>
  <div itemprop="reservationFor" itemscope itemtype="http://schema.org/Flight">
    <meta itemprop="flightNumber" content="${o.number}">
    <div itemprop="airline" itemscope itemtype="http://schema.org/Airline"><meta itemprop="name" content="${o.airline}"><meta itemprop="iataCode" content="${o.code}"></div>
    <div itemprop="departureAirport" itemscope itemtype="http://schema.org/Airport"><meta itemprop="name" content="${o.from[0]}"><meta itemprop="iataCode" content="${o.from[1]}"></div>
    <meta itemprop="departureTime" content="${o.dep}">
    <div itemprop="arrivalAirport" itemscope itemtype="http://schema.org/Airport"><meta itemprop="name" content="${o.to[0]}"><meta itemprop="iataCode" content="${o.to[1]}"></div>
    ${o.arr ? `<meta itemprop="arrivalTime" content="${o.arr}">` : ''}
  </div>
</div>`;

const parcel = {
  '@context': C, '@type': 'ParcelDelivery',
  carrier: { '@type': 'Organization', name: 'DHL' }, trackingNumber: '00340434161234567890',
  trackingUrl: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161234567890',
  expectedArrivalUntil: '2026-11-03T18:00:00+01:00',
  itemShipped: [{ '@type': 'Product', name: 'Wanderschuhe', image: 'https://img.shop.example.com/p/1.jpg' }, { '@type': 'Product', name: 'Socken' }],
  partOfOrder: { '@type': 'Order', orderNumber: 'SO-449120', merchant: { '@type': 'Organization', name: 'Outdoor Shop' }, orderStatus: 'http://schema.org/OrderInTransit' },
};

const orderObj = {
  '@context': C, '@type': 'Order', merchant: { '@type': 'Organization', name: 'Outdoor Shop' }, orderNumber: 'SO-449120',
  orderStatus: 'http://schema.org/OrderProcessing', priceCurrency: 'EUR', price: '129.90',
  acceptedOffer: [
    { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Wanderschuhe' }, price: '119.90', priceCurrency: 'EUR', eligibleQuantity: { '@type': 'QuantitativeValue', value: '1' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Socken' }, price: '5.00', priceCurrency: 'EUR', eligibleQuantity: { '@type': 'QuantitativeValue', value: '2' } },
  ],
  url: 'https://www.outdoor-shop.example.com/account/orders/SO-449120',
};

export const syntheticMails: MailFixture[] = [
  // Two passengers, two legs: four objects, one booking.
  {
    id: 'flight-two-passengers-two-legs', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld([
      flightRes({ ref: 'QX7K2M', name: 'Erika Mustermann', seat: '12A', ...out1, checkin: 'https://www.airline-a.example.com/checkin?pnr=QX7K2M' }),
      flightRes({ ref: 'QX7K2M', name: 'Max Mustermann', seat: '12B', ...out1, checkin: 'https://www.airline-a.example.com/checkin?pnr=QX7K2M' }),
      flightRes({ ref: 'QX7K2M', name: 'Erika Mustermann', seat: '31K', ...back1 }),
      flightRes({ ref: 'QX7K2M', name: 'Max Mustermann', seat: '31J', ...back1 }),
    ])),
  },
  // Eurowings-style: objects in a top-level array without commas between them.
  {
    id: 'eurowings-missing-commas', sender: 'airline-b.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(script(`[${eurowingsLegs.map((l) => JSON.stringify(l, null, 1)).join('\n')}]`)),
  },
  // Volotea-style: several objects without the array brackets.
  {
    id: 'volotea-missing-brackets', sender: 'airline-c.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(script(voloteaPax.map((p) => JSON.stringify(p)).join(',\n'))),
  },
  // Eventbrite-style trailing commas.
  {
    id: 'eventbrite-trailing-commas', sender: 'tickets.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(script(`{
      "@context": "http://schema.org", "@type": "EventReservation", "reservationNumber": "EB-1029384756",
      "underName": {"@type": "Person", "name": "Erika Mustermann",},
      "reservationFor": {"@type": "Event", "name": "Jazz im Park", "startDate": "2026-11-14T19:00:00+01:00", "endDate": "2026-11-14T22:30:00+01:00",
        "location": {"@type": "Place", "name": "Stadtpark", "address": {"@type": "PostalAddress", "streetAddress": "Parkweg 2", "addressLocality": "Hamburg", "addressCountry": "DE",},},},
      "ticketDownloadUrl": "https://tickets.example.com/t/EB-1029384756",
    }`)),
  },
  // Airbnb-style XML-entity-encoded JSON.
  {
    id: 'airbnb-entities', sender: 'stays.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(script(JSON.stringify({
      '@context': C, '@type': 'LodgingReservation', reservationNumber: 'HMXK29Q4ZP',
      reservationFor: { '@type': 'LodgingBusiness', name: 'Altbauwohnung am Kanal', address: { '@type': 'PostalAddress', addressLocality: 'Amsterdam', addressCountry: 'NL' } },
      checkinDate: '2027-01-15', checkoutDate: '2027-01-19', underName: person('Erika Mustermann'),
    }).replace(/"/g, '&quot;'))),
  },
  // @graph wrapper around a hotel reservation and its organisation.
  {
    id: 'graph-hotel', sender: 'hotel-booking.example.com', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({ '@context': C, '@graph': [{ ...hotel, '@context': undefined }, { '@type': 'Organization', name: 'Hotel Booking' }] })),
  },
  // Several @types; train seat with coach.
  {
    id: 'train-multiple-types', sender: 'rail.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({
      '@context': C, '@type': ['TrainReservation', 'Thing'], reservationNumber: 'RX4471', underName: 'Erika Mustermann',
      reservationStatus: 'ReservationConfirmed',
      reservationFor: {
        '@type': 'TrainTrip', trainNumber: 'ICE 577', provider: { '@type': 'Organization', name: 'Rail Co' },
        departureStation: { '@type': 'TrainStation', name: 'Hamburg Hbf', address: { '@type': 'PostalAddress', addressLocality: 'Hamburg', addressCountry: 'DE' } },
        departureTime: '2026-11-18T08:01:00+01:00',
        arrivalStation: { '@type': 'TrainStation', name: 'München Hbf', address: { '@type': 'PostalAddress', addressLocality: 'München', addressCountry: 'DE' } },
        arrivalTime: '2026-11-18T13:58:00+01:00',
      },
      reservedTicket: { '@type': 'Ticket', ticketedSeat: { '@type': 'Seat', seatSection: '12', seatNumber: '45' } },
    })),
  },
  // reservationFor as an array: one reservation per event.
  {
    id: 'event-reservationfor-array', sender: 'tickets.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({
      '@context': C, '@type': 'EventReservation', reservationNumber: 'KT-7781', underName: person('Erika Mustermann'),
      reservationFor: [
        { '@type': 'TheaterEvent', name: 'Faust I', startDate: '2026-11-21T19:30:00+01:00', location: { '@type': 'Place', name: 'Schauspielhaus', address: { addressLocality: 'Bochum', addressCountry: 'DE' } } },
        { '@type': 'TheaterEvent', name: 'Faust II', startDate: '2026-11-22T18:00:00+01:00', location: { '@type': 'Place', name: 'Schauspielhaus', address: { addressLocality: 'Bochum', addressCountry: 'DE' } } },
      ],
    })),
  },
  // Legacy property names: reservationId, checkinTime/checkoutTime, Url; string address.
  {
    id: 'hotel-legacy-names', sender: 'hotel-chain.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({
      '@context': 'https://schema.org/', '@type': 'LodgingReservation', reservationId: '84123376',
      reservationFor: { '@type': 'Resort', name: 'Seehotel Weiß', address: 'Seestraße 3, 83727 Schliersee, Deutschland' },
      checkinTime: '2026-12-27', checkoutTime: '2027-01-02', Url: 'https://hotel-chain.example.com/r/84123376',
    })),
  },
  // Restaurant subtype; string address.
  {
    id: 'restaurant-cafe', sender: 'tables.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({
      '@context': C, '@type': 'FoodEstablishmentReservation', reservationNumber: 'T-2231', reservationStatus: 'http://schema.org/Confirmed',
      underName: person('Erika Mustermann'), partySize: 4, startTime: '2026-11-07T19:30:00+01:00',
      reservationFor: { '@type': 'CafeOrCoffeeShop', name: 'Café Kranzler', address: 'Kurfürstendamm 18, 10719 Berlin' },
    })),
  },
  // Event with a date-only end (end of that day) and a country object.
  {
    id: 'event-date-only-end', sender: 'festival.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({
      '@context': C, '@type': 'EventReservation', reservationNumber: 'FS26-0042', underName: 'Erika Mustermann',
      reservationFor: { '@type': 'Festival', name: 'Winterfest', startDate: '2026-12-11', endDate: '2026-12-13',
        location: { '@type': 'Place', name: 'Messegelände', address: { '@type': 'PostalAddress', addressLocality: 'Wien', addressCountry: { '@type': 'Country', name: 'Austria' } } } },
    })),
  },
  // Lufthansa-style microdata with the arrival time missing: nothing.
  {
    id: 'microdata-flight-missing-arrival', sender: 'airline-d.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page('', microdataFlight({ ref: 'MD9X1Z', name: 'Erika Mustermann', number: '1234', code: 'LH', airline: 'Lufthansa', from: ['München', 'MUC'], dep: '2026-11-10T07:00:00+01:00', to: ['Hamburg', 'HAM'] })),
  },
  // Austrian-style microdata, two legs as two items.
  {
    id: 'microdata-two-legs', sender: 'airline-e.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page('',
      microdataFlight({ ref: 'OS4K7P', name: 'Erika Mustermann', number: 'OS122', code: 'OS', airline: 'Austrian', from: ['Wien', 'VIE'], dep: '2026-11-25T06:50:00+01:00', to: ['Frankfurt', 'FRA'], arr: '2026-11-25T08:15:00+01:00' })
      + microdataFlight({ ref: 'OS4K7P', name: 'Erika Mustermann', number: 'OS125', code: 'OS', airline: 'Austrian', from: ['Frankfurt', 'FRA'], dep: '2026-11-27T19:40:00+01:00', to: ['Wien', 'VIE'], arr: '2026-11-27T21:00:00+01:00' })),
  },
  // Iberia-style microdata: itemprop lists and values from text and datetime.
  {
    id: 'microdata-itemprop-lists', sender: 'airline-f.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page('', `
      <table itemscope itemtype="http://schema.org/FlightReservation"><tr>
        <td>Booking <span itemprop="reservationNumber">IB55XQ</span></td>
        <td itemprop="underName" itemscope itemtype="http://schema.org/Person"><span itemprop="name">Erika Mustermann</span></td>
        <td itemprop="reservationFor" itemscope itemtype="http://schema.org/Flight">
          <span itemprop="airline provider" itemscope itemtype="http://schema.org/Airline"><span itemprop="name">Iberia</span> (<span itemprop="iataCode">IB</span>)</span>
          <span itemprop="flightNumber">IB 3107</span>
          <span itemprop="departureAirport" itemscope itemtype="http://schema.org/Airport"><span itemprop="name">Madrid</span> <span itemprop="iataCode">MAD</span></span>
          <time itemprop="departureTime" datetime="2026-11-16T09:30:00+01:00">16 Nov 09:30</time>
          <span itemprop="arrivalAirport" itemscope itemtype="http://schema.org/Airport"><span itemprop="name">Barcelona</span> <span itemprop="iataCode">BCN</span></span>
          <time itemprop="arrivalTime" datetime="2026-11-16T10:50:00+01:00">10:50</time>
        </td></tr></table>`),
  },
  // Dates-only stay at a Resort, https context.
  {
    id: 'hotel-dates-only', sender: 'stays.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({
      '@context': 'https://schema.org', '@type': 'LodgingReservation', reservationNumber: 'RS-1188',
      reservationFor: { '@type': 'Resort', name: 'Strandresort Usedom', address: { '@type': 'PostalAddress', addressLocality: 'Heringsdorf', addressCountry: 'DE' } },
      checkinDate: '2027-06-01', checkoutDate: '2027-06-08',
    })),
  },
  // Rental car.
  {
    id: 'rental-car', sender: 'cars.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({
      '@context': C, '@type': 'RentalCarReservation', reservationNumber: 'RC-99123', underName: person('Erika Mustermann'),
      reservationFor: { '@type': 'Car', name: 'Golf', brand: { '@type': 'Brand', name: 'VW' }, rentalCompany: { '@type': 'Organization', name: 'Car Rental Co' } },
      pickupLocation: { '@type': 'Place', name: 'Flughafen BER', address: { '@type': 'PostalAddress', addressLocality: 'Schönefeld', addressCountry: 'DE' } },
      pickupTime: '2026-12-04T09:00:00+01:00',
      dropoffLocation: { '@type': 'Place', name: 'Flughafen BER', address: { '@type': 'PostalAddress', addressLocality: 'Schönefeld', addressCountry: 'DE' } },
      dropoffTime: '2026-12-07T18:00:00+01:00',
    })),
  },
  // A parcel on its own.
  {
    id: 'parcel', sender: 'outdoor-shop.example.com', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld(parcel)),
  },
  // Order and parcel for the same order number in one mail: one card.
  {
    id: 'order-and-parcel', sender: 'outdoor-shop.example.com', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld([orderObj, parcel])),
  },
  // Cancelled flight.
  {
    id: 'flight-cancelled', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld(flightRes({ ref: 'QX7K2M', name: 'Erika Mustermann', ...out1, status: 'ReservationCancelled' }))),
  },
  // Eastbound over the date line: lands earlier on the wall clock.
  {
    id: 'flight-date-line-eastbound', sender: 'airline-g.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld(flightRes({ ref: 'QF8H2L', name: 'Erika Mustermann', airline: ['Qantas', 'QF'], number: '11', from: ['Sydney', 'SYD'], dep: '2026-12-04T09:50:00+11:00', to: ['Los Angeles', 'LAX'], arr: '2026-12-04T06:20:00-08:00' }))),
  },

  // ---- doubtful: must give nothing
  {
    id: 'doubtful-arrival-before-departure', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld(flightRes({ ref: 'BAD001', name: 'Erika Mustermann', ...out1, arr: '2026-12-01T03:05:00-05:00' }))),
  },
  {
    id: 'doubtful-25-hour-flight', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld(flightRes({ ref: 'BAD002', name: 'Erika Mustermann', ...out1, arr: '2026-12-02T15:15:00-05:00' }))),
  },
  {
    id: 'doubtful-years-away', sender: 'stays.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({ ...hotel, reservationNumber: 'BAD003', checkinDate: '2029-05-01', checkoutDate: '2029-05-03' })),
  },
  {
    id: 'doubtful-checkout-before-checkin', sender: 'stays.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({ ...hotel, reservationNumber: 'BAD004', checkinDate: '2026-12-06', checkoutDate: '2026-12-04' })),
  },
  {
    id: 'doubtful-rental-missing-times', sender: 'cars.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({ '@context': C, '@type': 'RentalCarReservation', reservationNumber: 'BAD005', reservationFor: { '@type': 'Car', name: 'Golf' }, pickupTime: '2026-12-04', dropoffTime: '2026-12-07' })),
  },
  {
    id: 'doubtful-bare-date-departure', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld(flightRes({ ref: 'BAD006', name: 'Erika Mustermann', ...out1, dep: '2026-12-01' }))),
  },
  {
    id: 'doubtful-google-example', sender: 'newsletter.example', source: 'synthetic', mailDate: '2026-12-20T09:00:00Z',
    html: page(ld(flightRes({ ref: 'RXJ34P', name: 'Eva Green', airline: ['United', 'UA'], number: '110', seat: '9A', from: ['San Francisco Airport', 'SFO'], dep: '2027-03-04T20:15:00-08:00', to: ['John F. Kennedy International Airport', 'JFK'], arr: '2027-03-05T06:30:00-05:00' }))),
  },
  {
    id: 'doubtful-unknown-types-only', sender: 'newsletter.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld([{ '@context': C, '@type': 'PromotionCard', image: 'https://cdn.example.com/a.png' }, { '@context': C, '@type': 'DiscountOffer', description: '20% off' }])),
  },
  {
    id: 'doubtful-json-beyond-repair', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(script('{"@context": "http://schema.org", "@type": "FlightReservation", "reservationNumber": "BAD007", "reservationFor": {"@type": "Flight"')),
  },
  {
    id: 'doubtful-foreign-context', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld({ ...flightRes({ ref: 'BAD008', name: 'Erika Mustermann', ...out1 }), '@context': 'http://vocab.example.com/' })),
  },
  {
    id: 'doubtful-zone-mismatch', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld(flightRes({ ref: 'BAD009', name: 'Erika Mustermann', ...out1, dep: '2026-12-01T10:15:00+00:00', arr: '2026-12-01T13:05:00-05:00' }))),
  },
  {
    // One leg of a two-leg booking lacks its arrival: the whole booking goes.
    id: 'doubtful-one-bad-leg', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld([
      flightRes({ ref: 'BAD010', name: 'Erika Mustermann', ...out1 }),
      flightRes({ ref: 'BAD010', name: 'Erika Mustermann', ...back1, arr: '' }),
    ])),
  },
  {
    // The same leg twice with different times: the parts disagree.
    id: 'doubtful-conflicting-parts', sender: 'airline-a.example', source: 'synthetic', mailDate: MAIL_DATE,
    html: page(ld([
      flightRes({ ref: 'BAD011', name: 'Erika Mustermann', ...out1 }),
      flightRes({ ref: 'BAD011', name: 'Max Mustermann', ...out1, arr: '2026-12-01T14:05:00-05:00' }),
    ])),
  },
];
