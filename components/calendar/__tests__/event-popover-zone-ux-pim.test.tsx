import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDetailPopover } from '../event-detail-popover';
import { QuickCreatePopover, computePosition } from '../quick-create-popover';
import { useSettingsStore } from '@/stores/settings-store';
import { AUTO_TIME_ZONE } from '@/lib/timezone';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// pim-2: the popover of an event in another zone said nothing about it.
// pim-19: "Needs action" for an attendee who hasn't answered.
// pim-21: the quick editor cut a long calendar name off.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));

const calendar = { id: 'cal', name: 'Work', myRights: { mayWriteAll: true, mayWriteOwn: true } } as unknown as Calendar;

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1', calendarIds: { cal: true }, title: 'Call with New York office', start: '2026-11-05T10:00:00', duration: 'PT1H',
    timeZone: 'America/New_York', utcStart: '2026-11-05T15:00:00Z', utcEnd: '2026-11-05T16:00:00Z',
    showWithoutTime: false, participants: null, alerts: null, useDefaultAlerts: false,
    ...overrides,
  } as unknown as CalendarEvent;
}

function popover(e: CalendarEvent) {
  render(
    <EventDetailPopover event={e} calendar={calendar} anchorRect={new DOMRect(100, 100, 50, 20)}
      onEdit={vi.fn()} onDelete={vi.fn()} onDuplicate={vi.fn()} onClose={vi.fn()} onSaveNote={vi.fn()}
      currentUserEmails={['me@example.com']} />,
  );
}

beforeEach(() => useSettingsStore.setState({ timeZone: 'Europe/Berlin' }));
afterEach(() => useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE }));

describe('event popover', () => {
  it('shows the times on the event clock with the user times after them (pim-2)', () => {
    popover(event());
    expect(screen.getByTestId('event-zone-times').textContent)
      .toBe('zone_times:{"times":"10:00–11:00","zone":"New York","local":"16:00–17:00"}');
  });

  it('names the weekday on the event clock when its day there is another', () => {
    // 08:00 on Friday in Tokyo is 00:00 on Friday in Berlin; in New York
    // (the user here) it is still Thursday.
    useSettingsStore.setState({ timeZone: 'America/New_York' });
    popover(event({ timeZone: 'Asia/Tokyo', start: '2026-11-06T08:00:00', utcStart: '2026-11-05T23:00:00Z', utcEnd: '2026-11-06T00:00:00Z' }));
    expect(screen.getByTestId('event-zone-times').textContent)
      .toBe('zone_times:{"times":"Fri 08:00–09:00","zone":"Tokyo","local":"18:00–19:00"}');
  });

  it('shows the plain times for an event on the user clock, an all-day and a floating one', () => {
    popover(event({ timeZone: 'Europe/Berlin', start: '2026-11-05T16:00:00' }));
    popover(event({ id: 'e2', showWithoutTime: true, timeZone: null, start: '2026-11-05T00:00:00', duration: 'P1D' }));
    popover(event({ id: 'e3', timeZone: null, utcStart: undefined, utcEnd: undefined }));
    expect(screen.queryByTestId('event-zone-times')).toBeNull();
  });

  it('says an attendee has not answered yet in plain words (pim-19)', () => {
    popover(event({
      participants: {
        me: { '@type': 'Participant', name: 'Me', calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
        ben: { '@type': 'Participant', name: 'Ben', calendarAddress: 'mailto:ben@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
        eve: { '@type': 'Participant', name: 'Eve', calendarAddress: 'mailto:eve@example.com', roles: { attendee: true }, participationStatus: 'tentative' },
      },
    } as unknown as Partial<CalendarEvent>));
    expect(screen.getByText('status_needs_action')).toBeTruthy();
    expect(screen.getByText('status_tentative')).toBeTruthy();
    expect(screen.queryByText('participants.needs_action')).toBeNull();
  });
});

describe('quick create (pim-21)', () => {
  const long = 'Stalwart Calendar (dso-ux-pim@example.org)';
  const calendars = [
    { id: 'a', name: long, color: '#3b82f6' },
    { id: 'b', name: 'Work', color: '#22c55e' },
  ] as unknown as Calendar[];

  it('grows to fit the calendar names and names the calendar on hover', () => {
    render(
      <QuickCreatePopover draft={{ start: new Date(2026, 10, 15), end: new Date(2026, 10, 15), title: '', calendarId: 'a', allDay: true }}
        calendars={calendars} onChange={vi.fn()} onSave={vi.fn()} onMoreOptions={vi.fn()} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog');
    // As wide as its content (the select is as wide as its longest name), from 340 px on.
    expect(dialog.style.width).toBe('max-content');
    expect(dialog.style.minWidth).toBe('340px');
    expect(dialog.style.maxWidth).toContain('480px');
    expect(screen.getByRole('combobox').getAttribute('title')).toBe(long);
  });

  it('places a wider popover by its own width', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    // Beside an anchor at the right: 460 px don't fit on the right side, so it goes left of it.
    const anchor = new DOMRect(1000, 300, 150, 20);
    expect(computePosition(anchor, 200, 340)).toEqual({ top: 300, left: 652 });
    expect(computePosition(anchor, 200, 460)).toEqual({ top: 300, left: 532 });
  });
});
