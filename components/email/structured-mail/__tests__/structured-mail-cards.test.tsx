import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Keys with their parameters, so a test can see the facts that go into a string.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === 'route') return `${params!.from} to ${params!.to}`;
    return params ? `${key}${JSON.stringify(params)}` : key;
  },
  useLocale: () => 'en',
}));

const toastSuccess = vi.fn();
vi.mock('@/stores/toast-store', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }));

import expectedCards from '@/lib/structured-mail/__tests__/fixtures/expected-cards.json';
import type { Booking, Shipment, StructuredCard, TransportBooking } from '@/lib/structured-mail/types';
import { useSettingsStore } from '@/stores/settings-store';
import { StructuredMailCards } from '../structured-mail-cards';

const fixtures = expectedCards as unknown as Record<string, StructuredCard[]>;
const card = <T extends StructuredCard = StructuredCard>(id: string, index = 0) => structuredClone(fixtures[id][index]) as T;

const writeText = vi.fn().mockResolvedValue(undefined);
const initialSettings = useSettingsStore.getState();

beforeAll(() => {
  // Only Date is faked: "now" decides whether a year is shown.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  useSettingsStore.setState({ timeFormat: '24h', timeZone: 'Europe/Berlin' });
});
afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
  writeText.mockClear();
  toastSuccess.mockClear();
  vi.restoreAllMocks();
});

function show(cards: StructuredCard[], extra: Partial<Parameters<typeof StructuredMailCards>[0]> = {}) {
  return render(<StructuredMailCards cards={cards} email={{ id: 'm1' }} allowRemoteImages={false} {...extra} />);
}

describe('StructuredMailCards', () => {
  it('renders nothing for an empty list', () => {
    const { container } = show([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a flight with its route, legs at local time, passengers and seats', () => {
    show([card('flight-two-passengers-two-legs')]);
    const region = screen.getByRole('region', { name: 'region_flight' });
    expect(within(region).getByRole('heading', { name: 'FRA to JFK to FRA' })).toBeInTheDocument();
    expect(within(region).getAllByTestId('structured-mail-stop').map((el) => el.textContent)).toEqual(['FRA', 'JFK', 'FRA']);
    expect(region).toHaveTextContent('kind_flight · Lufthansa');
    const legs = within(region).getAllByTestId('structured-mail-leg');
    expect(legs).toHaveLength(2);
    // The mail's wall clock at each airport: 10:15 in Frankfurt, 13:05 in New York.
    expect(legs[0]).toHaveTextContent('Lufthansa LH 400');
    expect(legs[0]).toHaveTextContent('Tue, Dec 1, 10:15 · Frankfurt Airport (FRA)');
    expect(legs[0]).toHaveTextContent('13:05local_time · John F. Kennedy International Airport (JFK)');
    // Overnight return: the arrival date is written out.
    expect(legs[1]).toHaveTextContent('Tue, Dec 8, 17:30');
    expect(legs[1]).toHaveTextContent('Wed, Dec 9, 07:20 · Frankfurt Airport (FRA)');
    expect(legs[0]).toHaveTextContent('seats: Erika Mustermann 12A, Max Mustermann 12B');
    expect(region).toHaveTextContent('Erika Mustermann, Max Mustermann');
  });

  it('marks only the times whose place keeps another clock than the reader', () => {
    show([card('flight-two-passengers-two-legs')]);
    const [outbound] = screen.getAllByTestId('structured-mail-leg');
    // Reader in Berlin: Frankfurt needs no mark, New York does.
    const hints = within(outbound).getAllByTestId('local-time-hint');
    expect(hints).toHaveLength(1);
    expect(hints[0].closest('div')).toHaveTextContent('John F. Kennedy');
  });

  it('never shifts the time to the reader zone', () => {
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo' });
    show([card('flight-two-passengers-two-legs')]);
    const [outbound] = screen.getAllByTestId('structured-mail-leg');
    expect(outbound).toHaveTextContent('Tue, Dec 1, 10:15');
    expect(outbound).toHaveTextContent('13:05');
    expect(within(outbound).getAllByTestId('local-time-hint')).toHaveLength(2);
  });

  it('copies the booking reference', async () => {
    show([card('flight-two-passengers-two-legs')]);
    fireEvent.click(screen.getByRole('button', { name: 'copy_reference{"value":"QX7K2M"}' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('QX7K2M'));
    expect(toastSuccess).toHaveBeenCalledWith('copied_reference');
  });

  it('shows the check-in link with its host and opens it like a body link', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    show([card('flight-two-passengers-two-legs')]);
    const link = screen.getByRole('link', { name: /link_check_in/ });
    expect(link).toHaveTextContent('link_check_in· airline-a.example.com');
    expect(link).toHaveAttribute('href', 'https://www.airline-a.example.com/checkin?pnr=QX7K2M');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await act(async () => { fireEvent.click(link); });
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://www.airline-a.example.com/checkin?pnr=QX7K2M', '_blank', 'noopener,noreferrer'));
  });

  it('never renders a link that is not http(s)', () => {
    const flight = card<TransportBooking>('flight-two-passengers-two-legs');
    flight.links = { checkin: { url: 'javascript:alert(1)', host: 'evil.example' }, manage: { url: 'data:text/html,x', host: 'x' } };
    show([flight]);
    expect(screen.queryAllByTestId('structured-mail-link')).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('javascript:');
  });

  it('shows a cancelled booking struck through with a Cancelled pill', () => {
    show([card('flight-cancelled')]);
    const region = screen.getByRole('region', { name: 'region_flight' });
    expect(within(region).getByText('status_cancelled')).toBeInTheDocument();
    expect(within(region).getByRole('heading')).toHaveClass('line-through');
  });

  it('marks a single cancelled leg of a live booking', () => {
    const flight = card<TransportBooking>('flight-two-passengers-two-legs');
    flight.legs[1].status = 'cancelled';
    show([flight]);
    const legs = screen.getAllByTestId('structured-mail-leg');
    expect(within(legs[1]).getByText('status_cancelled')).toBeInTheDocument();
    expect(within(legs[0]).queryByText('status_cancelled')).toBeNull();
    expect(screen.getByRole('heading')).not.toHaveClass('line-through');
  });

  it('shows Pending and On hold', () => {
    const pending = card<TransportBooking>('train-multiple-types');
    pending.status = 'pending';
    const hold = card<Booking>('graph-hotel');
    hold.status = 'hold';
    show([pending, hold]);
    expect(screen.getByRole('region', { name: 'region_train' })).toHaveTextContent('status_pending');
    expect(screen.getByRole('region', { name: 'region_lodging' })).toHaveTextContent('status_hold');
  });

  it('titles a train with its towns and lists the stations', () => {
    show([card('train-multiple-types')]);
    const region = screen.getByRole('region', { name: 'region_train' });
    expect(within(region).getByRole('heading', { name: 'Hamburg to München' })).toBeInTheDocument();
    expect(region).toHaveTextContent('Wed, Nov 18, 08:01 · Hamburg Hbf');
    expect(region).toHaveTextContent('13:58 · München Hbf');
    expect(region).toHaveTextContent('Rail Co ICE 577');
  });

  it('shows a hotel stay with address, check-in and check-out times, nights and the manage link', () => {
    show([card('graph-hotel')]);
    const region = screen.getByRole('region', { name: 'region_lodging' });
    expect(within(region).getByRole('heading', { name: 'Hotel Am Markt' })).toBeInTheDocument();
    expect(region).toHaveTextContent('Marktplatz 1, 10178 Berlin, Germany');
    expect(region).toHaveTextContent('check_in_label Fri, Dec 4, from_time{"time":"15:00"}');
    expect(region).toHaveTextContent('check_out_label Sun, Dec 6, until_time{"time":"11:00"}');
    expect(region).toHaveTextContent('nights{"count":2}');
    expect(within(region).getByRole('link', { name: /link_manage/ })).toHaveTextContent('hotel-booking.example.com');
  });

  it('shows a dates-only stay without times', () => {
    show([card('hotel-dates-only')]);
    const region = screen.getByRole('region', { name: 'region_lodging' });
    expect(region).toHaveTextContent('check_in_label Tue, Jun 1, 2027');
    expect(region).toHaveTextContent('check_out_label Tue, Jun 8, 2027');
    expect(region).not.toHaveTextContent('from_time');
    expect(region).toHaveTextContent('nights{"count":7}');
  });

  it('shows a rental car with pick-up, return and car', () => {
    show([card('rental-car')]);
    const region = screen.getByRole('region', { name: 'region_rentalcar' });
    expect(within(region).getByRole('heading', { name: 'Car Rental Co' })).toBeInTheDocument();
    expect(region).toHaveTextContent('pickup Fri, Dec 4, 09:00 · Flughafen BER, Schönefeld');
    expect(region).toHaveTextContent('dropoff Mon, Dec 7, 18:00 · Flughafen BER, Schönefeld');
    expect(region).toHaveTextContent('VW Golf');
  });

  it('shows an event with its times, venue, tickets and ticket link', () => {
    const event = card('eventbrite-trailing-commas');
    const ahoi = card('ahoi-event');
    show([event, ahoi]);
    const [eventbrite, workshop] = screen.getAllByRole('region', { name: 'region_event' });
    expect(within(eventbrite).getByRole('heading', { name: 'Jazz im Park' })).toBeInTheDocument();
    expect(eventbrite).toHaveTextContent('Sat, Nov 14, 19:00 – 22:30');
    expect(eventbrite).toHaveTextContent('Stadtpark, Parkweg 2, Hamburg, Germany');
    expect(within(eventbrite).getByRole('link', { name: /link_ticket/ })).toHaveTextContent('tickets.example.com');
    expect(workshop).toHaveTextContent('Sun, Jul 18, 2021, 14:00');
    expect(workshop).toHaveTextContent('tickets: AB12CD-1');
  });

  it('shows a restaurant table with time, address and party size', () => {
    show([card('restaurant-cafe')]);
    const region = screen.getByRole('region', { name: 'region_restaurant' });
    expect(within(region).getByRole('heading', { name: 'Café Kranzler' })).toBeInTheDocument();
    expect(region).toHaveTextContent('Sat, Nov 7, 19:30');
    expect(region).toHaveTextContent('Kurfürstendamm 18, 10719 Berlin');
    expect(region).toHaveTextContent('party_size{"count":4}');
  });

  it('shows an order with its parcel: number, status, items, total, tracking and links', async () => {
    show([card('order-and-parcel')]);
    const region = screen.getByRole('region', { name: 'region_shipment' });
    expect(within(region).getByRole('heading', { name: 'Outdoor Shop' })).toBeInTheDocument();
    expect(region).toHaveTextContent('kind_order · DHL');
    expect(region).toHaveTextContent('order_status_in_transit');
    expect(region).toHaveTextContent('Wanderschuhe, Socken');
    expect(region).toHaveTextContent('items_count{"count":3} · total{"total":"€129.90"}');
    expect(region).toHaveTextContent('expected_by{"date":"Tue, Nov 3"}');
    expect(within(region).getByRole('link', { name: /link_track/ })).toHaveTextContent('link_track· dhl.de');
    expect(within(region).getByRole('link', { name: /link_view_order/ })).toHaveTextContent('outdoor-shop.example.com');

    fireEvent.click(within(region).getByRole('button', { name: 'copy_tracking_number{"value":"00340434161234567890"}' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('00340434161234567890'));
    fireEvent.click(within(region).getByRole('button', { name: 'copy_order_number{"value":"SO-449120"}' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('SO-449120'));
  });

  it('drops the expected date once the order is delivered', () => {
    const shipment = card<Shipment>('order-and-parcel');
    shipment.status = 'delivered';
    show([shipment]);
    const region = screen.getByRole('region', { name: 'region_shipment' });
    expect(region).toHaveTextContent('order_status_delivered');
    expect(region).not.toHaveTextContent('expected_by');
    // Carrier and tracking number stay.
    expect(region).toHaveTextContent('00340434161234567890');
  });

  describe('right-to-left place names and values', () => {
    const hebrewTrain = (): TransportBooking => {
      const train = card<TransportBooking>('train-multiple-types');
      train.legs[0].departure.place = { name: 'תל אביב סבידור מרכז', address: { locality: 'תל אביב', country: 'IL' } };
      train.legs[0].arrival!.place = { name: 'חיפה מרכז השמונה', address: { locality: 'חיפה', country: 'IL' } };
      return train;
    };

    it.each(['rtl', 'ltr'] as const)('isolates each stop and draws the arrow as a mirrored icon (%s UI)', (dir) => {
      render(
        <div dir={dir}>
          <StructuredMailCards cards={[hebrewTrain()]} email={{ id: 'm1' }} allowRemoteImages={false} />
        </div>,
      );
      const region = screen.getByRole('region', { name: 'region_train' });
      // Spoken in reading order, whatever the script.
      expect(within(region).getByRole('heading', { name: 'תל אביב to חיפה' })).toBeInTheDocument();
      const stops = within(region).getAllByTestId('structured-mail-stop');
      expect(stops.map((el) => el.tagName)).toEqual(['BDI', 'BDI']);
      expect(stops.map((el) => el.textContent)).toEqual(['תל אביב', 'חיפה']);
      const visual = within(region).getByTestId('structured-mail-title-visual');
      // No arrow character the bidi algorithm could turn around: an icon between the stops.
      expect(visual.textContent).not.toMatch(/[→←]/);
      const arrow = visual.querySelector('svg');
      expect(arrow).toHaveClass('tabler-icon-arrow-right');
      expect(arrow!.compareDocumentPosition(stops[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(stops[0].compareDocumentPosition(arrow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Station names in the leg rows are isolated too.
      const leg = within(region).getByTestId('structured-mail-leg');
      expect([...leg.querySelectorAll('bdi')].map((el) => el.textContent)).toEqual(expect.arrayContaining(['תל אביב סבידור מרכז', 'חיפה מרכז השמונה']));
    });

    it('relies on the global mirror for that arrow in RTL', async () => {
      const { readFileSync } = await import('node:fs');
      const css = readFileSync(`${process.cwd()}/app/globals.css`, 'utf8');
      expect(css).toMatch(/\[dir="rtl"\] \.tabler-icon-arrow-right/);
    });

    it('keeps references, tracking and order numbers, seats and tickets left to right', () => {
      render(
        <div dir="rtl">
          <StructuredMailCards
            cards={[card('flight-two-passengers-two-legs'), card('ahoi-event'), card('order-and-parcel')]}
            email={{ id: 'm1' }}
            allowRemoteImages={false}
          />
        </div>,
      );
      for (const value of ['QX7K2M', 'AB12CD', 'SO-449120', '00340434161234567890']) {
        expect(screen.getAllByText(value)[0]).toHaveAttribute('dir', 'ltr');
      }
      const seats = screen.getAllByTestId('structured-mail-seat');
      expect(seats.map((el) => el.textContent)).toEqual(['12A', '12B', '31K', '31J']);
      seats.forEach((el) => expect(el).toHaveAttribute('dir', 'ltr'));
      expect(screen.getByTestId('structured-mail-tickets')).toHaveAttribute('dir', 'ltr');
      expect(screen.getByTestId('structured-mail-tickets')).toHaveTextContent('AB12CD-1');
    });
  });

  it('shows no action row when a card has nothing it would put there', () => {
    const restaurant = card<Booking>('restaurant-cafe');
    delete restaurant.reference;
    // A restaurant card shows no ticket link, so this alone gives no row.
    restaurant.links = { ticket: { url: 'https://tables.example.com/t/1', host: 'tables.example.com' } };
    show([restaurant]);
    const region = screen.getByRole('region', { name: 'region_restaurant' });
    expect(within(region).queryByTestId('structured-mail-actions')).toBeNull();
    expect(within(region).queryByRole('link')).toBeNull();
  });

  it('shows one Track button per tracking page', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shipment = card<Shipment>('order-and-parcel');
    const parcel = shipment.parcels[0];
    // The same parcel twice (same number and page), and a second one with its own page.
    shipment.parcels = [parcel, { ...parcel }, { ...parcel, trackingNumber: '00340434169999999999', trackingUrl: { url: 'https://www.dhl.de/x?piececode=00340434169999999999', host: 'dhl.de' } }];
    show([shipment]);
    const region = screen.getByRole('region', { name: 'region_shipment' });
    const tracks = within(region).getAllByRole('link', { name: /link_track/ });
    expect(tracks.map((a) => a.getAttribute('href'))).toEqual([parcel.trackingUrl!.url, 'https://www.dhl.de/x?piececode=00340434169999999999']);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });

  it('lists three items and says how many more there are', () => {
    const shipment: Shipment = {
      kind: 'shipment', key: 's', merchant: 'Shop', orderNumber: 'A-1', source: 'json-ld', parcels: [],
      items: ['One', 'Two', 'Three', 'Four', 'Five'].map((name) => ({ name })),
      total: { amount: '1299.00', currency: 'USD' },
    };
    show([shipment]);
    const region = screen.getByRole('region', { name: 'region_shipment' });
    expect(region).toHaveTextContent('One, Two, Three items_more{"count":2}');
    expect(region).not.toHaveTextContent('Four');
    expect(region).toHaveTextContent('total{"total":"$1,299.00"}');
  });

  it('loads item images only when remote content is allowed, without a referrer', () => {
    const { unmount, container } = show([card('order-and-parcel')]);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    unmount();
    const allowed = show([card('order-and-parcel')], { allowRemoteImages: true });
    const imgs = allowed.container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute('src', 'https://img.shop.example.com/p/1.jpg');
    expect(imgs[0]).toHaveAttribute('referrerpolicy', 'no-referrer');
    // The item names are in the text already.
    expect(imgs[0]).toHaveAttribute('alt', '');
  });

  it('gives each booking to the calendar slot, and none for a shipment', () => {
    const slot = vi.fn((booking: Booking) => <button type="button">{`add ${booking.kind}`}</button>);
    show([card('flight-two-passengers-two-legs'), card('graph-hotel'), card('order-and-parcel')], { calendarActions: slot });
    expect(slot).toHaveBeenCalledTimes(2);
    expect(slot.mock.calls.map(([b]) => b.kind)).toEqual(['flight', 'lodging']);
    expect(slot.mock.calls[0][0]).toMatchObject({ reference: 'QX7K2M' });
    expect(within(screen.getByRole('region', { name: 'region_flight' })).getByRole('button', { name: 'add flight' })).toBeInTheDocument();
  });

  it('renders no action row items for the calendar when the slot is undefined', () => {
    show([card('restaurant-cafe')]);
    const region = screen.getByRole('region', { name: 'region_restaurant' });
    // Only the reference chip.
    expect(within(region).getAllByRole('button')).toHaveLength(1);
  });
});
