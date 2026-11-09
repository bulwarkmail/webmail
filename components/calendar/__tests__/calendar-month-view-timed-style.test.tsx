import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarMonthView } from '../calendar-month-view';
import type { CalendarEvent, Calendar, CalendarParticipant } from '@/lib/jmap/types';
import { useSettingsStore, adminPolicyPatch } from '@/stores/settings-store';

// #1449: the month view can draw timed events as coloured text or as a dot
// and text, so they don't look like all-day events. All-day and multi-day
// events, and declined or cancelled ones, stay bars.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function makeEvent(id: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    '@type': 'Event',
    uid: id,
    title: 'Event ' + id,
    start: '2026-09-09T09:30:00',
    duration: 'PT30M',
    showWithoutTime: false,
    status: 'confirmed',
    calendarIds: { 'cal-1': true },
    ...overrides,
  } as unknown as CalendarEvent;
}

function renderView(events: CalendarEvent[]) {
  return render(
    <CalendarMonthView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="month:2026-09-09"
      rangeStart={new Date(2026, 7, 31)}
      rangeEnd={new Date(2026, 9, 4)}
      selectedDate={new Date(2026, 8, 9)}
      events={events}
      calendars={calendars}
      onSelectDate={vi.fn()}
      onSelectEvent={vi.fn()}
      currentUserEmails={['me@example.com']}
    />,
  );
}

function card(title: string): HTMLElement {
  return screen.getByText(title).closest('button')!;
}

const timed = makeEvent('timed');
const allDay = makeEvent('allday', { start: '2026-09-10T00:00:00', duration: 'P1D', showWithoutTime: true });
const multiDay = makeEvent('multi', { start: '2026-09-14T22:00:00', duration: 'PT26H' });
const cancelled = makeEvent('cancelled', { start: '2026-09-11T10:00:00', status: 'cancelled' });
const declined = makeEvent('declined', {
  start: '2026-09-11T11:00:00',
  participants: {
    me: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', participationStatus: 'declined' },
  } as unknown as Record<string, CalendarParticipant>,
});
const all = [timed, allDay, multiDay, cancelled, declined];

describe('month view timed event style (#1449)', () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ calendarMonthTimedEvents: 'bar', showTimeInMonthView: false });
  });

  it('draws every event as a bar by default', () => {
    renderView(all);
    for (const title of ['Event timed', 'Event allday', 'Event multi']) {
      expect(card(title).style.backgroundColor, title).not.toBe('');
      expect(card(title).hasAttribute('data-timed-style'), title).toBe(false);
    }
  });

  it('draws a timed event as its time and title in the calendar colour', () => {
    useSettingsStore.setState({ calendarMonthTimedEvents: 'text' });
    renderView(all);
    const el = card('Event timed');
    expect(el.getAttribute('data-timed-style')).toBe('text');
    expect(el.style.backgroundColor).toBe('');
    expect(el.style.color).toContain('color-mix');
    expect(el.style.color).toContain('#123456');
    // The start time shows even with "Show time in month view" off.
    expect(el.textContent).toContain('09:30');
    expect(el.querySelector('[data-event-dot]')).toBeNull();
  });

  it('puts a dot in the calendar colour before a timed event in the text colour', () => {
    useSettingsStore.setState({ calendarMonthTimedEvents: 'dot' });
    renderView(all);
    const el = card('Event timed');
    expect(el.getAttribute('data-timed-style')).toBe('dot');
    expect(el.style.backgroundColor).toBe('');
    expect(el.style.color).toBe('var(--color-foreground)');
    expect(el.querySelector<HTMLElement>('[data-event-dot]')?.style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(el.textContent).toContain('09:30');
  });

  it.each(['text', 'dot'] as const)('keeps all-day, multi-day, cancelled and declined events as they were (%s)', (style) => {
    useSettingsStore.setState({ calendarMonthTimedEvents: style });
    renderView(all);
    for (const title of ['Event allday', 'Event multi']) {
      expect(card(title).hasAttribute('data-timed-style'), title).toBe(false);
      expect(card(title).style.backgroundColor, title).not.toBe('');
    }
    for (const title of ['Event cancelled', 'Event declined']) {
      expect(card(title).hasAttribute('data-timed-style'), title).toBe(false);
      expect(card(title).style.boxShadow, title).toContain('inset 0 0 0 1px');
      expect(screen.getByText(title)).toHaveClass('line-through');
    }
  });

  it('keeps the selection ring on a text-style event', () => {
    useSettingsStore.setState({ calendarMonthTimedEvents: 'text' });
    render(
      <CalendarMonthView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="month:2026-09-09"
        rangeStart={new Date(2026, 7, 31)}
        rangeEnd={new Date(2026, 9, 4)}
        selectedDate={new Date(2026, 8, 9)}
        events={[timed]}
        calendars={calendars}
        onSelectDate={vi.fn()}
        onSelectEvent={vi.fn()}
        selectedEventId="timed"
      />,
    );
    expect(card('Event timed').style.boxShadow).toContain('var(--color-primary)');
  });

  it('can be preset by an admin policy, and only with a known style', () => {
    expect(adminPolicyPatch({}, { defaults: { calendarMonthTimedEvents: 'dot' } })).toEqual({ calendarMonthTimedEvents: 'dot' });
    expect(adminPolicyPatch({}, { defaults: { calendarMonthTimedEvents: 'stripes' } })).toEqual({});
  });
});
