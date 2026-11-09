import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarEvent, Email } from '@/lib/jmap/types';
import { loadAirportZones, readStructuredMail, resolveCards, type Booking, type StructuredCard } from '@/lib/structured-mail';
import { bookingToEvents } from '@/lib/structured-mail/calendar';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { usePolicyStore } from '@/stores/policy-store';
import { BookingCalendarActions } from '../booking-calendar-actions';
import { useBookingCalendar } from '../use-booking-calendar';

const ctx = 'http://schema.org';
const NOW = new Date('2026-11-01T12:00:00Z');
const EMAIL = { from: [{ email: 'booking@mail.lufthansa.com' }], subject: 'Your booking QX7K2M' } as unknown as Email;

function leg(number: string, dep: [string, string], arr: [string, string], status?: string) {
  return {
    '@context': ctx, '@type': 'FlightReservation', reservationNumber: 'QX7K2M', underName: 'Erika Mustermann',
    ...(status ? { reservationStatus: `http://schema.org/${status}` } : {}),
    reservationFor: {
      '@type': 'Flight', flightNumber: number, airline: { name: 'Lufthansa', iataCode: 'LH' },
      departureAirport: { iataCode: dep[0] }, departureTime: dep[1],
      arrivalAirport: { iataCode: arr[0] }, arrivalTime: arr[1],
    },
  };
}

const OUT = leg('400', ['FRA', '2026-12-01T10:15:00+01:00'], ['JFK', '2026-12-01T13:05:00-05:00']);
const OUT_MOVED = leg('400', ['FRA', '2026-12-01T12:40:00+01:00'], ['JFK', '2026-12-01T15:35:00-05:00']);
const BACK = leg('401', ['JFK', '2026-12-08T17:30:00-05:00'], ['FRA', '2026-12-09T07:20:00+01:00']);
const BACK_CANCELLED = leg('401', ['JFK', '2026-12-08T17:30:00-05:00'], ['FRA', '2026-12-09T07:20:00+01:00'], 'ReservationCancelled');
const OUT_CANCELLED = leg('400', ['FRA', '2026-12-01T10:15:00+01:00'], ['JFK', '2026-12-01T13:05:00-05:00'], 'ReservationCancelled');

async function bookingFrom(items: unknown[], mailDate = '2026-10-30T10:00:00Z'): Promise<Booking> {
  const html = `<html><head>${items.map((i) => `<script type="application/ld+json">${JSON.stringify(i)}</script>`).join('')}</head></html>`;
  const cards = resolveCards(readStructuredMail(html, { mailDate: new Date(mailDate) }), await loadAirportZones());
  expect(cards).toHaveLength(1);
  return cards[0] as Booking;
}

/** CalendarEvent/get's shape for an event made from `wanted`: id, calendar, server defaults. */
function stored(wanted: Partial<CalendarEvent>, id: string, calendarId = 'cal-default'): CalendarEvent {
  const locations = Object.fromEntries(Object.entries(wanted.locations ?? {}).map(([key, loc]) => [key, { ...loc, iCalendar: { name: 'vlocation' } }]));
  return {
    ...wanted, id, calendarIds: { [calendarId]: true }, utcStart: null, utcEnd: null, participants: null,
    description: 'whatever the server keeps', locations,
  } as unknown as CalendarEvent;
}

const rights = (write: boolean) => ({ mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: write, mayWriteOwn: write, mayUpdatePrivate: true, mayRSVP: true, mayShare: false, mayDelete: write });
const cal = (id: string, extra: Partial<Calendar> = {}): Calendar => ({
  id, name: id, color: '#3366ff', isDefault: false, isSubscribed: true, isVisible: true, sortOrder: 0, description: null,
  includeInAvailability: 'all', defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: null, shareWith: null,
  myRights: rights(true), ...extra,
} as Calendar);

const client = { queryCalendarEvents: vi.fn() };
const createEvent = vi.fn();
const updateEvent = vi.fn();
const deleteEvent = vi.fn();

const initialCalendar = useCalendarStore.getState();
const initialAuth = useAuthStore.getState();
const initialPolicy = usePolicyStore.getState();

function setCalendarGate(on: boolean) {
  usePolicyStore.setState((s) => ({ policy: { ...s.policy, features: { ...s.policy.features, calendarEnabled: on } } }));
}

/** The calendar holds these events, found by uid. */
function calendarHolds(events: CalendarEvent[]) {
  client.queryCalendarEvents.mockImplementation(async (filter: { uid: string }) => events.filter((e) => e.uid === filter.uid));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  client.queryCalendarEvents.mockReset();
  calendarHolds([]);
  createEvent.mockReset().mockImplementation(async (_client, event: Partial<CalendarEvent>) => {
    const created = { ...event, id: `new-${event.uid}` } as CalendarEvent;
    useCalendarStore.setState((s) => ({ events: [...s.events, created] }));
    return created;
  });
  updateEvent.mockReset().mockResolvedValue(true);
  deleteEvent.mockReset().mockResolvedValue(true);
  setCalendarGate(true);
  useAuthStore.setState({ client: client as never, activeAccountId: null });
  useCalendarStore.setState({
    supportsCalendar: true,
    calendars: [cal('cal-default', { isDefault: true })],
    events: [],
    icalSubscriptions: [],
    createEvent, updateEvent, deleteEvent,
    setSelectedDate: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  useCalendarStore.setState(initialCalendar, true);
  useAuthStore.setState(initialAuth, true);
  usePolicyStore.setState(initialPolicy, true);
});

async function settled(card: StructuredCard) {
  const hook = renderHook(({ b }) => useBookingCalendar(b, EMAIL), { initialProps: { b: card } });
  await waitFor(() => expect(hook.result.current.status).not.toBe('loading'));
  return hook;
}

describe('useBookingCalendar', () => {
  it('offers to add a booking the calendar lacks, and adds each live leg once', async () => {
    const booking = await bookingFrom([OUT, BACK]);
    const { result } = await settled(booking);
    expect(result.current.status).toBe('add');
    expect(client.queryCalendarEvents).toHaveBeenCalledTimes(2);

    await act(() => result.current.add('cal-default'));
    expect(createEvent).toHaveBeenCalledTimes(2);
    const [, first] = createEvent.mock.calls[0];
    const wanted = bookingToEvents(booking, { senderDomain: 'lufthansa.com' })[0];
    expect(first).toMatchObject({
      uid: wanted.uid, calendarIds: { 'cal-default': true }, title: 'LH 400 FRA → JFK',
      start: '2026-12-01T10:15:00', timeZone: 'Europe/Berlin', duration: 'PT8H50M',
    });
    expect(first).not.toHaveProperty('participants');
    expect(createEvent.mock.calls[0]).toHaveLength(2);
    expect(result.current.status).toBe('in-calendar');
    expect(result.current.notice).toBe('added');
  });

  it('says the booking is in the calendar when every leg is there unchanged', async () => {
    const booking = await bookingFrom([OUT, BACK]);
    const [a, b] = bookingToEvents(booking, { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(a, 'e1'), stored(b, 'e2')]);
    const { result } = await settled(booking);
    expect(result.current.status).toBe('in-calendar');
    expect(useCalendarStore.getState().events.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('updates the found event after a schedule change and never creates a second one', async () => {
    const before = await bookingFrom([OUT]);
    const [old] = bookingToEvents(before, { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(old, 'e1')]);
    const { result } = await settled(await bookingFrom([OUT_MOVED]));
    expect(result.current.status).toBe('update');

    await act(() => result.current.update());
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateEvent).toHaveBeenCalledTimes(1);
    const [, id, patch, scheduling] = updateEvent.mock.calls[0];
    expect(id).toBe('e1');
    expect(patch).toMatchObject({ start: '2026-12-01T12:40:00', timeZone: 'Europe/Berlin', duration: 'PT8H55M' });
    // The stored description isn't the generated one any more: title and notes stay the user's.
    expect(patch).not.toHaveProperty('title');
    expect(patch).not.toHaveProperty('description');
    expect(scheduling).toBeUndefined();
    expect(result.current.status).toBe('in-calendar');
  });

  it('adds a missing leg next to the others, in their calendar, as an update', async () => {
    useCalendarStore.setState({ calendars: [cal('cal-default', { isDefault: true }), cal('cal-travel')] });
    const booking = await bookingFrom([OUT, BACK]);
    const [a] = bookingToEvents(booking, { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(a, 'e1', 'cal-travel')]);
    const { result } = await settled(booking);
    expect(result.current.status).toBe('update');
    await act(() => result.current.update());
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0][1]).toMatchObject({ title: 'LH 401 JFK → FRA', calendarIds: { 'cal-travel': true } });
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('offers to remove a cancelled booking that is in the calendar, and removes it', async () => {
    const [old] = bookingToEvents(await bookingFrom([OUT]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(old, 'e1')]);
    const { result } = await settled(await bookingFrom([OUT_CANCELLED]));
    expect(result.current.status).toBe('remove');
    await act(() => result.current.remove());
    expect(deleteEvent).toHaveBeenCalledWith(client, 'e1');
    expect(createEvent).not.toHaveBeenCalled();
    expect(result.current.status).toBe('cancelled');
    expect(result.current.notice).toBe('removed');
  });

  it('offers nothing for a cancelled booking the calendar never had', async () => {
    const { result } = await settled(await bookingFrom([OUT_CANCELLED]));
    expect(result.current.status).toBe('cancelled');
  });

  it('never adds a cancelled leg, and removes its event along with the update', async () => {
    const booking = await bookingFrom([OUT, BACK_CANCELLED]);
    const { result } = await settled(booking);
    expect(result.current.status).toBe('add');
    await act(() => result.current.add());
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0][1]).toMatchObject({ title: 'LH 400 FRA → JFK' });

    const [a, b] = bookingToEvents(await bookingFrom([OUT, BACK]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(a, 'e1'), stored(b, 'e2')]);
    createEvent.mockClear();
    const second = await settled(booking);
    expect(second.result.current.status).toBe('update');
    await act(() => second.result.current.update());
    expect(deleteEvent).toHaveBeenCalledWith(client, 'e2');
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('does not find events another sender domain made', async () => {
    const booking = await bookingFrom([OUT]);
    const [foreign] = bookingToEvents(booking, { senderDomain: 'lufthansa-deals.com' });
    calendarHolds([stored(foreign, 'e9')]);
    const { result } = await settled(booking);
    expect(result.current.status).toBe('add');
  });

  it('shows nothing for a booking that is over', async () => {
    vi.setSystemTime(new Date('2026-12-02T12:00:00Z'));
    const { result } = renderHook(() => useBookingCalendar(null, EMAIL));
    expect(result.current.status).toBe('hidden');
    const booking = await bookingFrom([OUT]);
    const past = renderHook(() => useBookingCalendar(booking, EMAIL));
    expect(past.result.current.status).toBe('hidden');
    expect(client.queryCalendarEvents).not.toHaveBeenCalled();
  });

  it('shows nothing with the admin calendar gate off or without calendar support', async () => {
    const booking = await bookingFrom([OUT]);
    setCalendarGate(false);
    expect(renderHook(() => useBookingCalendar(booking, EMAIL)).result.current.status).toBe('hidden');
    setCalendarGate(true);
    useCalendarStore.setState({ supportsCalendar: false });
    expect(renderHook(() => useBookingCalendar(booking, EMAIL)).result.current.status).toBe('hidden');
    expect(client.queryCalendarEvents).not.toHaveBeenCalled();
  });

  it('shows nothing for shipments', () => {
    const shipment: StructuredCard = { kind: 'shipment', key: 'shipment|order:1', orderNumber: '1', items: [], parcels: [], source: 'json-ld' };
    expect(renderHook(() => useBookingCalendar(shipment, EMAIL)).result.current.status).toBe('hidden');
  });

  it('shows nothing when the lookup fails, rather than risk a duplicate', async () => {
    client.queryCalendarEvents.mockRejectedValue(new Error('offline'));
    const { result } = await settled(await bookingFrom([OUT]));
    expect(result.current.status).toBe('hidden');
  });

  it('says why an add failed', async () => {
    createEvent.mockImplementation(async () => {
      useCalendarStore.setState({ error: 'Failed to create event' });
      return null;
    });
    const { result } = await settled(await bookingFrom([OUT]));
    await act(() => result.current.add());
    expect(result.current.error).toBe('action_failed');
    expect(result.current.status).toBe('add');
  });

  it('says so when a plugin stops an add, an update or a removal', async () => {
    createEvent.mockResolvedValue(null);
    const fresh = await settled(await bookingFrom([OUT]));
    await act(() => fresh.result.current.add());
    expect(fresh.result.current).toMatchObject({ notice: 'blocked', error: null, status: 'add' });

    const [old] = bookingToEvents(await bookingFrom([OUT]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(old, 'e1')]);
    updateEvent.mockResolvedValue(false);
    const moved = await settled(await bookingFrom([OUT_MOVED]));
    await act(() => moved.result.current.update());
    expect(moved.result.current).toMatchObject({ notice: 'blocked', status: 'update' });

    deleteEvent.mockResolvedValue(false);
    const cancelled = await settled(await bookingFrom([OUT_CANCELLED]));
    await act(() => cancelled.result.current.remove());
    expect(cancelled.result.current).toMatchObject({ notice: 'blocked', status: 'remove' });
  });

  it('shows a booking added from another card for the same booking as in the calendar', async () => {
    const booking = await bookingFrom([OUT]);
    const first = await settled(booking);
    const second = await settled(await bookingFrom([OUT]));
    expect(first.result.current.status).toBe('add');
    expect(second.result.current.status).toBe('add');
    await act(() => second.result.current.add());
    expect(second.result.current.status).toBe('in-calendar');
    await waitFor(() => expect(first.result.current.status).toBe('in-calendar'));
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('shows a booking removed from another card as gone', async () => {
    const [old] = bookingToEvents(await bookingFrom([OUT]), { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(old, 'e1')]);
    deleteEvent.mockImplementation(async (_client, id: string) => {
      useCalendarStore.setState((s) => ({ events: s.events.filter((e) => e.id !== id) }));
      return true;
    });
    const first = await settled(await bookingFrom([OUT_CANCELLED]));
    const second = await settled(await bookingFrom([OUT_CANCELLED]));
    expect(first.result.current.status).toBe('remove');
    await act(() => second.result.current.remove());
    await waitFor(() => expect(first.result.current.status).toBe('cancelled'));
  });
});

describe('BookingCalendarActions', () => {
  it('lists only writable event calendars of the own account, the default first', async () => {
    useCalendarStore.setState({
      calendars: [
        cal('Work'),
        cal('Personal', { isDefault: true }),
        cal('Tasks', { isTasksOnly: true }),
        cal('Holidays', { myRights: rights(false) }),
        cal('Team', { isShared: true, accountId: 'other' }),
        cal('Feed'),
      ],
      icalSubscriptions: [{ id: 'sub', calendarId: 'Feed', url: 'x', name: 'Feed', color: '#000', refreshInterval: 60 } as never],
    });
    render(<BookingCalendarActions booking={await bookingFrom([OUT])} email={EMAIL} />);
    fireEvent.click(await screen.findByRole('button', { name: /add_to_calendar/ }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Personal', 'Work']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][1]).toMatchObject({ calendarIds: { Work: true } });
    expect(await screen.findByText('added')).toBeTruthy();
  });

  async function openPicker() {
    useCalendarStore.setState({ calendars: [cal('Personal', { isDefault: true }), cal('Work'), cal('Travel')] });
    render(<BookingCalendarActions booking={await bookingFrom([OUT])} email={EMAIL} />);
    const trigger = await screen.findByRole('button', { name: /add_to_calendar/ });
    fireEvent.click(trigger);
    return { trigger, menu: screen.getByRole('menu') };
  }

  it('moves focus into the picker and through it with the arrow keys, Home and End', async () => {
    const { menu } = await openPicker();
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    // The heading is the app menu's header row: not an item, so the keys skip it.
    const header = menu.querySelector<HTMLElement>('[data-context-menu-header]');
    expect(header?.textContent).toBe('select_calendar');
    expect(header?.closest('[role="menuitem"]')).toBeNull();
    expect(header?.hasAttribute('tabindex')).toBe(false);
    expect(items.map((item) => item.textContent)).toEqual(['Personal', 'Work', 'Travel']);
  });

  it('closes the picker on Escape and gives focus back to its button', async () => {
    const { trigger, menu } = await openPicker();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('stays open while its own list scrolls, and closes when the page scrolls', async () => {
    const { menu } = await openPicker();
    // The menu starts listening a tick after it opens, so the click that opened it doesn't close it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.scroll(menu.firstElementChild ?? menu);
    expect(screen.queryByRole('menu')).not.toBeNull();
    // A page scroll is fired at the document.
    fireEvent.scroll(document);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('puts focus on the outcome after a pick', async () => {
    await openPicker();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('status'));
    expect(document.activeElement?.textContent).toBe('added');
  });

  it('keeps the picker inside a 390 px wide screen when the button sits at the right edge', async () => {
    useCalendarStore.setState({ calendars: [cal('Personal', { isDefault: true }), cal('Work')] });
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    // jsdom lays nothing out: the menu measures as 208 px wide, as it is on a phone.
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isMenu = this.getAttribute('role') === 'menu';
      const w = isMenu ? 208 : 0;
      const h = isMenu ? 120 : 0;
      return { left: 0, right: w, top: 0, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) };
    });
    try {
      render(<BookingCalendarActions booking={await bookingFrom([OUT])} email={EMAIL} />);
      const button = await screen.findByRole('button', { name: /add_to_calendar/ });
      button.getBoundingClientRect = () => ({ left: 300, right: 382, top: 500, bottom: 536, width: 82, height: 36, x: 300, y: 500, toJSON: () => ({}) });
      fireEvent.click(button);
      const menu = screen.getByRole('menu');
      const left = parseFloat(menu.style.left);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + 208).toBeLessThanOrEqual(390 - 8);
    } finally {
      measure.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('adds straight away when there is one calendar to choose, then shows the pill and the way to the calendar', async () => {
    const booking = await bookingFrom([OUT]);
    const { rerender } = render(<BookingCalendarActions booking={booking} email={EMAIL} />);
    fireEvent.click(await screen.findByRole('button', { name: /add_to_calendar/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0][1]).toMatchObject({ calendarIds: { 'cal-default': true } });

    const [wanted] = bookingToEvents(booking, { senderDomain: 'lufthansa.com' });
    calendarHolds([stored(wanted, 'e1')]);
    rerender(<BookingCalendarActions booking={{ ...booking }} email={{ ...EMAIL }} key="again" />);
    expect(await screen.findByText('in_calendar')).toBeTruthy();
    expect(screen.getByRole('button', { name: /view_in_calendar/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add_to_calendar/ })).toBeNull();
  });

  it('renders nothing for a booking that is over', async () => {
    const booking = await bookingFrom([OUT]);
    vi.setSystemTime(new Date('2026-12-02T12:00:00Z'));
    const { container } = render(<BookingCalendarActions booking={booking} email={EMAIL} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
    expect(client.queryCalendarEvents).not.toHaveBeenCalled();
  });
});
