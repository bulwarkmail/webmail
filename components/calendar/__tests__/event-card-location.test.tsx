import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { EventCard } from '../event-card';
import type { CalendarEvent } from '@/lib/jmap/types';

// The event's location on its tile in month, week and day view (#1686). A
// block shorter than 45 minutes has room for its title line only, as for
// the time line.

function makeEvent(duration: string, location: string | null = 'Room 4.12'): CalendarEvent {
  return {
    id: 'e1',
    '@type': 'Event',
    uid: 'u1',
    title: 'Planning',
    start: '2026-11-20T10:00:00',
    duration,
    showWithoutTime: false,
    status: 'confirmed',
    calendarIds: { 'cal-1': true },
    locations: location ? { loc1: { '@type': 'Location', name: location } } : null,
  } as unknown as CalendarEvent;
}

const locationOf = () => document.querySelector('[data-event-location]');

describe('EventCard location', () => {
  afterEach(() => cleanup());

  it.each([
    ['PT30M', false],
    ['PT45M', true],
    ['PT2H', true],
  ])('shows the location on a %s block: %s', (duration, shown) => {
    render(<EventCard event={makeEvent(duration)} variant="block" />);
    expect(locationOf()?.textContent === 'Room 4.12').toBe(shown);
  });

  it.each(['span', 'chip'] as const)('shows the location after the title (%s)', (variant) => {
    render(<EventCard event={makeEvent('PT1H')} variant={variant} />);
    expect(locationOf()?.textContent).toBe('Room 4.12');
  });

  it('shows it in the month view text style too', () => {
    render(<EventCard event={makeEvent('PT1H')} variant="span" timedStyle="dot" />);
    expect(locationOf()?.textContent).toBe('Room 4.12');
  });

  it('names the location to screen readers', () => {
    render(<EventCard event={makeEvent('PT1H')} variant="block" />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain(', Room 4.12');
  });

  it('adds nothing for an event without a location', () => {
    render(<EventCard event={makeEvent('PT1H', null)} variant="block" />);
    expect(locationOf()).toBeNull();
  });
});
