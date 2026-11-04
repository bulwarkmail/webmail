import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { useSettingsStore } from '@/stores/settings-store';
import { AUTO_TIME_ZONE, fromDisplayDate } from '@/lib/timezone';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import type { EventEditorState } from '@/lib/recurrence-scope-edit';

// pim-2: an edit kept the event's time but moved it into the user's zone
// (every save wrote timeZone: <user's zone>), and there was no way to put an
// event in another zone. pim-7: the form asked for the date and time last.
// pim-19, pim-22: plain words for the participant answers and "(No title)".

// Keys with their values, so a test can read what a line says.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));
vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const RIGHTS = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const calendars = [
  { id: 'cal', name: 'Work', color: '#123456', isDefault: true, myRights: RIGHTS },
  { id: 'home', name: 'Home', color: '#654321', isDefault: false, myRights: RIGHTS },
] as unknown as Calendar[];

// 10:00-11:00 in New York on 5 November (UTC-5): 16:00-17:00 in Berlin.
const newYork = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Call with New York office', description: '',
  start: '2026-11-05T10:00:00', duration: 'PT1H', timeZone: 'America/New_York',
  utcStart: '2026-11-05T15:00:00Z', utcEnd: '2026-11-05T16:00:00Z',
  showWithoutTime: false, calendarIds: { cal: true }, participants: null, alerts: null, recurrenceRules: null,
} as unknown as CalendarEvent;

function editor(event: CalendarEvent | null, extra: Partial<Parameters<typeof EventModal>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<EventModal event={event} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} {...extra} />);
  return onSave;
}

async function save(onSave: ReturnType<typeof vi.fn>): Promise<{ data: Partial<CalendarEvent>; state: EventEditorState }> {
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return { data: onSave.mock.calls[0][0], state: onSave.mock.calls[0][2] };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

// The picker is Settings' searchable one (pim-p2-5): type a city, pick it.
async function pickZone(city: string) {
  const search = await screen.findByRole('combobox', { name: 'time_zone_search' });
  fireEvent.change(search, { target: { value: city } });
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${city}`) }));
}

beforeEach(() => useSettingsStore.setState({ timeZone: 'Europe/Berlin' }));
// jsdom has no layout; the picker scrolls its active option into view.
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE }));

describe('the event editor keeps the event in its own time zone (pim-2)', () => {
  it('shows the times on the event clock and says which zone that is', () => {
    editor(newYork);
    expect(field('form.start_time').value).toBe('10:00');
    expect(field('form.end_time').value).toBe('11:00');
    expect(screen.getByText(/^time_zone_line:/).textContent).toBe('time_zone_line:{"zone":"New York"}');
    expect(screen.getByText(/^your_time:/).textContent).toBe('your_time:{"times":"16:00–17:00"}');
  });

  it('saves a title change with the zone and start the event had', async () => {
    const onSave = editor(newYork);
    fireEvent.change(field('form.title'), { target: { value: 'Call with New York office, room 2' } });
    const { data, state } = await save(onSave);
    expect(data).toMatchObject({ title: 'Call with New York office, room 2', start: '2026-11-05T10:00:00', timeZone: 'America/New_York', duration: 'PT1H' });
    // The editor state stays in display dates: the same instant.
    expect(fromDisplayDate(state.when.start).toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(state.timeZoneChanged).toBeUndefined();
  });

  // Review of pim-2: the duration and the editor state came from Dates in the
  // browser's zone. 01:00-04:00 in New York on the night its clocks go
  // forward lasts two hours, not three; and 02:30 exists in New York on the
  // night Berlin's clocks go forward, where a browser Date moved it to 03:30.
  it("counts the duration on the event's clock across its daylight-saving switch", async () => {
    const onSave = editor({ ...newYork, start: '2026-03-08T01:00:00', duration: 'PT2H', utcStart: '2026-03-08T06:00:00Z', utcEnd: '2026-03-08T08:00:00Z' } as CalendarEvent);
    expect(field('form.end_time').value).toBe('04:00');
    fireEvent.change(field('form.title'), { target: { value: 'Night shift handover' } });
    const { data } = await save(onSave);
    expect(data).toMatchObject({ start: '2026-03-08T01:00:00', timeZone: 'America/New_York', duration: 'PT2H' });
  });

  it("keeps a time that falls in the browser's daylight-saving gap", async () => {
    const onSave = editor(newYork);
    fireEvent.change(field('form.start_date'), { target: { value: '2026-03-29' } });
    fireEvent.change(field('form.end_date'), { target: { value: '2026-03-29' } });
    fireEvent.change(field('form.start_time'), { target: { value: '02:30' } });
    fireEvent.change(field('form.end_time'), { target: { value: '03:30' } });
    const { data, state } = await save(onSave);
    expect(data).toMatchObject({ start: '2026-03-29T02:30:00', duration: 'PT1H' });
    // 02:30 in New York (UTC-4 since 8 March) is 06:30 UTC.
    expect(fromDisplayDate(state.when.start).toISOString()).toBe('2026-03-29T06:30:00.000Z');
  });

  it('moves the event on its own clock', async () => {
    const onSave = editor(newYork);
    fireEvent.change(field('form.start_time'), { target: { value: '12:00' } });
    const { data } = await save(onSave);
    expect(data).toMatchObject({ start: '2026-11-05T12:00:00', timeZone: 'America/New_York', duration: 'PT1H' });
  });

  it('creates an event in another zone through the picker', async () => {
    const onSave = editor(null, { defaultDate: new Date(2026, 10, 12, 10, 0), defaultEndDate: new Date(2026, 10, 12, 11, 0) });
    fireEvent.change(field('form.title'), { target: { value: 'Tokyo partner sync' } });
    // A new event is in the user's zone, behind a small link.
    expect(screen.queryByText(/^time_zone_line/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'time_zone' }));
    await pickZone('Tokyo');
    const { data, state } = await save(onSave);
    expect(data).toMatchObject({ start: '2026-11-12T10:00:00', timeZone: 'Asia/Tokyo', duration: 'PT1H' });
    // 10:00 in Tokyo is 01:00 UTC.
    expect(fromDisplayDate(state.when.start).toISOString()).toBe('2026-11-12T01:00:00.000Z');
  });

  it('tells the series save when the user picked another zone', async () => {
    const onSave = editor(newYork);
    fireEvent.click(screen.getByText(/^time_zone_line:/));
    await pickZone('Tokyo');
    const { data, state } = await save(onSave);
    expect(data).toMatchObject({ start: '2026-11-05T10:00:00', timeZone: 'Asia/Tokyo' });
    expect(state.timeZoneChanged).toBe(true);
  });

  it('leaves a floating event without a zone', async () => {
    const onSave = editor({ ...newYork, timeZone: null, utcStart: undefined, utcEnd: undefined } as unknown as CalendarEvent);
    expect(screen.queryByTestId('event-time-zone')).toBeNull();
    fireEvent.change(field('form.title'), { target: { value: 'Floating' } });
    const { data } = await save(onSave);
    expect(data).toMatchObject({ start: '2026-11-05T10:00:00', timeZone: null });
  });

  it('shows the event clock beside the user one in the summary', () => {
    render(<EventModal event={newYork} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('event-zone-times').textContent)
      .toBe('zone_times:{"times":"10:00–11:00","zone":"New York","local":"16:00–17:00"}');
  });

  it('shows no zone line for an event on the user clock', () => {
    render(<EventModal event={{ ...newYork, timeZone: 'Europe/Paris' } as CalendarEvent} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('event-zone-times')).toBeNull();
  });
});

describe('the time zone picker is the one Settings has (pim-p2-5)', () => {
  it('lists cities with their offset, common ones first, and no "Automatic"', async () => {
    editor(newYork);
    fireEvent.click(screen.getByText(/^time_zone_line:/));
    const options = await screen.findAllByRole('option');
    const names = options.map((o) => o.textContent ?? '');
    // Common zones lead: UTC, then Los Angeles; no raw ids like "Africa/Abidjan" first.
    expect(names[0]).toMatch(/^UTC/);
    expect(names.some((n) => n.startsWith('New York') && /GMT-0[45]:00/.test(n))).toBe(true);
    expect(names.some((n) => n.includes('/'))).toBe(false);
    expect(screen.queryByText(/time_zone\.auto/)).toBeNull();
  });

  it('finds a zone by typing its city and saves the IANA id', async () => {
    const onSave = editor(newYork);
    fireEvent.click(screen.getByText(/^time_zone_line:/));
    await pickZone('Kolkata');
    const { data } = await save(onSave);
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(data.timeZone);
  });

  it("shows an event's old zone id by its current city name", () => {
    editor({ ...newYork, timeZone: 'Europe/Kiev' } as CalendarEvent);
    expect(screen.getByText(/^time_zone_line:/).textContent).toBe('time_zone_line:{"zone":"Kyiv"}');
  });

  it('gives the "Time zone" link the link colour, not the near-white primary of the dark theme (pim-p2-19)', () => {
    editor(null, { defaultDate: new Date(2026, 10, 12, 10, 0), defaultEndDate: new Date(2026, 10, 12, 11, 0) });
    const link = screen.getByRole('button', { name: 'time_zone' });
    expect(link.className).toContain('dark:text-blue-400');
    expect(link.className).not.toContain('text-primary');
  });
});

describe('the event form order (pim-7)', () => {
  it('asks for the time right after the title and for the description last', () => {
    editor(null, { defaultDate: new Date(2026, 10, 12, 10, 0), defaultEndDate: new Date(2026, 10, 12, 11, 0) });
    const order = ['form.title', 'form.all_day_event', 'form.start_date', 'form.end_time', 'recurrence.title', 'form.calendar_select',
      'form.location', 'form.meeting_link', 'participants.title', 'alerts.title', 'form.description'];
    const nodes = order.map((label) => screen.getAllByText(label).find((el) => el.closest('label')) ?? screen.getAllByText(label)[0]);
    for (let i = 1; i < nodes.length; i++) {
      const before = nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(before, `${order[i - 1]} before ${order[i]}`).toBeTruthy();
    }
  });
});

describe('plain words (pim-19, pim-22)', () => {
  it('says "Not answered yet" for an attendee who has not answered', () => {
    const meeting = {
      ...newYork,
      participants: {
        me: { '@type': 'Participant', name: 'Me', calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
        ben: { '@type': 'Participant', name: 'Ben', calendarAddress: 'mailto:ben@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
      },
    } as unknown as CalendarEvent;
    render(<EventModal event={meeting} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    expect(screen.getByText('status_needs_action')).toBeTruthy();
    expect(screen.getByText('status_accepted')).toBeTruthy();
    expect(screen.queryByText('participants.needs_action')).toBeNull();
  });

  it('labels the grid preview of an untitled event in the user language', () => {
    const onPreviewChange = vi.fn();
    editor(null, { defaultDate: new Date(2026, 10, 12, 10, 0), defaultEndDate: new Date(2026, 10, 12, 11, 0), onPreviewChange });
    const last = onPreviewChange.mock.calls.filter(([p]) => p).pop()![0];
    expect(last.title).toBe('events.no_title');
  });
});
