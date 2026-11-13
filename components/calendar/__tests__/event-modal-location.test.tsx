import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// #1674: the form sent the location with six null members. Stalwart exports
// a location with a description, locationTypes or links member as a
// VLOCATION without a LOCATION line, and guests' calendars showed none.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date | string) => String(d),
    relativeTime: (d: Date | string) => String(d),
    number: (n: number) => String(n),
  }),
}));

const calendars = [
  { id: 'cal-1', name: 'Work', isDefault: true, myRights: { mayWriteAll: true, mayWriteOwn: true } },
] as unknown as Calendar[];

async function savedData(onSave: ReturnType<typeof vi.fn>): Promise<Partial<CalendarEvent>> {
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0];
}

describe('EventModal location', () => {
  it('sends a new location with its name only', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal calendars={calendars} defaultDate={new Date('2026-11-20T10:00:00')} defaultCalendarId="cal-1" onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Sync' } });
    fireEvent.change(screen.getByPlaceholderText('form.location'), { target: { value: 'Room 4' } });

    const data = await savedData(onSave);
    expect(data.locations).toEqual({ loc1: { '@type': 'Location', name: 'Room 4' } });
  });

  it('keeps the members a stored location had when its name changes', async () => {
    const event = {
      id: 'evt-1', '@type': 'Event', uid: 'uid-1', calendarIds: { 'cal-1': true }, title: 'Review', description: '',
      start: '2026-11-20T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
      participants: null, recurrenceRules: null, virtualLocations: null, alerts: null,
      locations: { x7: { '@type': 'Location', name: 'HQ', description: 'Second floor', coordinates: 'geo:52.5,13.4', links: null } },
    } as unknown as CalendarEvent;
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={event} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('form.location'), { target: { value: 'HQ Berlin' } });

    const data = await savedData(onSave);
    expect(data.locations).toEqual({
      x7: { '@type': 'Location', name: 'HQ Berlin', description: 'Second floor', coordinates: 'geo:52.5,13.4' },
    });
  });
});
