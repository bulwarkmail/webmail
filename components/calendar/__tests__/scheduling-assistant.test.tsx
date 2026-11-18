import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SchedulingAssistant } from '../scheduling-assistant';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { BusyPeriod, Principal } from '@/lib/jmap/types';

vi.mock('../free-busy-share-button', () => ({ FreeBusyShareButton: () => createElement('div', { 'data-testid': 'share-button' }) }));

const DIRECTORY: Principal[] = [
  { id: 'me', type: 'individual', name: 'me', email: 'me@example.org' },
  { id: 'bob', type: 'individual', name: 'bob', email: 'bob@example.org' },
  { id: 'carol', type: 'individual', name: 'carol', email: 'carol@example.org' },
  { id: 'dan', type: 'individual', name: 'dan', email: 'dan@example.org' },
];

function fakeClient(periods: Record<string, BusyPeriod[]>, errors: Record<string, string> = {}) {
  const calls: Array<{ ids: string[]; start: string }> = [];
  const client = {
    getUsername: () => 'me@example.org',
    getAccountId: () => 'me',
    supportsAvailability: () => true,
    mayGetAvailability: async () => true,
    listPrincipals: async () => ({ principals: DIRECTORY, status: 'ok' }),
    getPrincipals: async () => DIRECTORY,
    getPrincipalsAvailability: async (ids: string[], start: Date) => {
      calls.push({ ids, start: start.toISOString() });
      return Object.fromEntries(ids.map((id) => [id, errors[id] ? { error: errors[id] } : { periods: periods[id] ?? [] }]));
    },
  };
  return { client: client as unknown as IJMAPClient, calls };
}

const busy = (utcStart: string, utcEnd: string, busyStatus: BusyPeriod['busyStatus'] = 'confirmed'): BusyPeriod => ({ utcStart, utcEnd, busyStatus });

// Thursday 5 November 2026, 10:00-11:00 in Berlin.
const START = new Date('2026-11-05T09:00:00Z');
const END = new Date('2026-11-05T10:00:00Z');

function open(props: Partial<Parameters<typeof SchedulingAssistant>[0]> = {}) {
  const onPick = vi.fn();
  render(createElement(SchedulingAssistant, {
    attendees: [
      { name: 'Bob', email: 'bob@example.org' },
      { name: 'Carol', email: 'carol@example.org' },
      { name: 'Dan', email: 'dan@example.org', optional: true },
      { name: '', email: 'x@outside.com' },
    ],
    start: START,
    end: END,
    onPick,
    ...props,
  }));
  fireEvent.click(screen.getByTestId('scheduling-assistant-button'));
  return { onPick, dialog: screen.getByTestId('scheduling-assistant') };
}

const row = (key: string) => document.querySelector(`[data-row="${key}"]`) as HTMLElement;
const slot = () => document.querySelector('[data-slot-block]') as HTMLElement;
// The timeline 1440px wide from x = 0: a pixel a minute.
function layOut() {
  const timeline = screen.getByTestId('scheduling-assistant-timeline');
  vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1440, width: 1440, top: 0, bottom: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) });
}

describe('SchedulingAssistant', () => {
  beforeEach(() => {
    useSettingsStore.setState({ timeZone: 'Europe/Berlin', calendarWorkingDays: [1, 2, 3, 4, 5], calendarDayStartHour: 9, calendarDayEndHour: 17, timeFormat: '24h' });
    useCalendarStore.setState({ calendars: [] } as never);
  });
  afterEach(() => {
    useAuthStore.setState({ client: null } as never);
    useSettingsStore.setState({ timeZone: 'auto' });
    vi.restoreAllMocks();
  });

  it('shows everyone’s busy time on the event’s day, with one lookup for all of them', async () => {
    const { client, calls } = fakeClient({
      me: [busy('2026-11-05T07:00:00Z', '2026-11-05T08:00:00Z')], // 8-9
      bob: [busy('2026-11-05T12:00:00Z', '2026-11-05T13:00:00Z'), busy('2026-11-05T14:00:00Z', '2026-11-05T14:30:00Z', 'tentative')],
      dan: [busy('2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z')], // optional: not in "All attendees"
    });
    useAuthStore.setState({ client } as never);
    open();
    await waitFor(() => expect(row('bob@example.org').getAttribute('data-row-state')).toBe('known'));

    expect(row('you').querySelectorAll('[data-busy="busy"]')).toHaveLength(1);
    expect(row('bob@example.org').querySelectorAll('[data-busy="busy"]')).toHaveLength(1);
    expect(row('bob@example.org').querySelectorAll('[data-busy="tentative"]')).toHaveLength(1);
    // No busy time and no calendar of hers in sight: can't tell free from not shared.
    expect(row('carol@example.org').getAttribute('data-row-state')).toBe('not_checked');
    expect(row('x@outside.com').getAttribute('data-row-state')).toBe('not_checked');
    expect(row('dan@example.org').className).toMatch(/opacity-50/);
    // Everyone: me 8-9, Bob 13-14 and the tentative 15-15:30; Dan is optional.
    const everyone = row('everyone');
    expect([...everyone.querySelectorAll('[data-busy]')].map((el) => el.getAttribute('data-busy'))).toEqual(['busy', 'busy', 'tentative']);
    expect(everyone.querySelectorAll('[data-everyone-free]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('share-button')).toBeInTheDocument();

    expect(calls).toEqual([{ ids: ['me', 'bob', 'carol', 'dan'], start: '2026-11-04T23:00:00.000Z' }]);
  });

  it('moves the event with a click, a drag and the arrow keys, and hands the time to the editor', async () => {
    const { client } = fakeClient({});
    useAuthStore.setState({ client } as never);
    const { onPick } = open();
    await waitFor(() => expect(row('bob@example.org').getAttribute('data-row-state')).not.toBe('loading'));
    layOut();

    // A click at 14:05 puts the start at 14:00, keeping the hour.
    fireEvent.click(screen.getByTestId('scheduling-assistant-timeline'), { clientX: 14 * 60 + 5 });
    expect(slot().getAttribute('data-slot-start')).toBe('2026-11-05T13:00:00.000Z');
    expect(slot().getAttribute('data-slot-end')).toBe('2026-11-05T14:00:00.000Z');

    // Dragged by half an hour.
    fireEvent.pointerDown(slot(), { button: 0, pointerId: 1, clientX: 14 * 60 + 20 });
    fireEvent.pointerMove(slot(), { pointerId: 1, clientX: 14 * 60 + 50 });
    fireEvent.pointerUp(slot(), { pointerId: 1, clientX: 14 * 60 + 50 });
    expect(slot().getAttribute('data-slot-start')).toBe('2026-11-05T13:30:00.000Z');

    // Its end dragged to 16:00.
    const handle = slot().querySelector('[data-slot-resize]')!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 15 * 60 + 30 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 16 * 60 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 16 * 60 });
    expect(slot().getAttribute('data-slot-end')).toBe('2026-11-05T15:00:00.000Z');

    // A quarter of an hour later, then a quarter of an hour shorter.
    fireEvent.keyDown(slot(), { key: 'ArrowRight' });
    fireEvent.keyDown(slot(), { key: 'ArrowLeft', shiftKey: true });
    expect(slot().getAttribute('data-slot-start')).toBe('2026-11-05T13:45:00.000Z');
    expect(slot().getAttribute('data-slot-end')).toBe('2026-11-05T15:00:00.000Z');

    // Nothing changes in the editor until the time is taken.
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('scheduling-assistant-use'));
    expect(onPick).toHaveBeenCalledWith({ start: new Date('2026-11-05T13:45:00Z'), end: new Date('2026-11-05T15:00:00Z') });
    expect(screen.queryByTestId('scheduling-assistant')).toBeNull();
  });

  it('goes to the next day, looks that day up, and places the event there with a click', async () => {
    const { client, calls } = fakeClient({});
    useAuthStore.setState({ client } as never);
    open({ attendees: [{ name: 'Bob', email: 'bob@example.org' }] });
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByTestId('scheduling-assistant-next'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].start).toBe('2026-11-05T23:00:00.000Z');
    // The event is on Thursday, not on the Friday shown.
    expect(slot()).toBeNull();
    await waitFor(() => expect(row('bob@example.org').getAttribute('data-row-state')).toBe('not_checked'));
    layOut();
    fireEvent.click(screen.getByTestId('scheduling-assistant-timeline'), { clientX: 9 * 60 });
    expect(slot().getAttribute('data-slot-start')).toBe('2026-11-06T08:00:00.000Z');
  });

  it('says so when the server refuses free/busy', async () => {
    const { client } = fakeClient({}, { me: 'forbidden', bob: 'forbidden' });
    useAuthStore.setState({ client } as never);
    const { dialog } = open({ attendees: [{ name: 'Bob', email: 'bob@example.org' }] });
    expect(await within(dialog).findByText('unavailable_on_server')).toBeInTheDocument();
    expect(screen.queryByTestId('scheduling-assistant-grid')).toBeNull();
  });

  it('is not offered without attendees or on a server without free/busy', () => {
    const { client } = fakeClient({});
    useAuthStore.setState({ client } as never);
    const { container, rerender } = render(createElement(SchedulingAssistant, { attendees: [], start: START, end: END, onPick: vi.fn() }));
    expect(container).toBeEmptyDOMElement();
    useAuthStore.setState({ client: { ...client, supportsAvailability: () => false } } as never);
    rerender(createElement(SchedulingAssistant, { attendees: [{ name: 'Bob', email: 'bob@example.org' }], start: START, end: END, onPick: vi.fn() }));
    expect(container).toBeEmptyDOMElement();
  });
});
