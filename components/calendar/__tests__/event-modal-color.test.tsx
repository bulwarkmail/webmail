import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// A colour for one event (#1668): the editor writes event.color, and
// "Use calendar color" clears it.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const own = { id: 'own', name: 'Personal', color: '#123456', isDefault: true, myRights: rights } as unknown as Calendar;

const event = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Dentist', description: '', start: '2026-11-20T10:00:00',
  duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { own: true },
  participants: null, alerts: null, recurrenceRules: null, freeBusyStatus: 'busy', privacy: 'public',
} as unknown as CalendarEvent;

async function savedData(onSave: ReturnType<typeof vi.fn>): Promise<Partial<CalendarEvent>> {
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0];
}

describe('EventModal colour', () => {
  it('saves a new event in the picked colour', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal calendars={[own]} defaultDate={new Date('2026-11-20T10:00:00')} defaultCalendarId="own" onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByTestId('event-color-calendar').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '#ef4444' }));
    expect(screen.getByTestId('event-color-calendar').getAttribute('aria-pressed')).toBe('false');

    const data = await savedData(onSave);
    expect(data.color).toBe('#ef4444');
  });

  it('sends no colour for a new event left in its calendar colour', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal calendars={[own]} defaultDate={new Date('2026-11-20T10:00:00')} defaultCalendarId="own" onSave={onSave} onClose={vi.fn()} />);

    const data = await savedData(onSave);
    expect('color' in data).toBe(false);
  });

  it('clears an event colour with "Use calendar color"', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const red = { ...event, color: '#ef4444' } as CalendarEvent;
    render(<EventModal event={red} startInEditMode calendars={[own]} onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByTestId('event-color-calendar').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('event-color-calendar'));

    const data = await savedData(onSave);
    expect(data.color).toBeNull();
  });

  it('leaves the colour out of an edit that did not change it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const red = { ...event, color: '#ef4444' } as CalendarEvent;
    render(<EventModal event={red} startInEditMode calendars={[own]} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('form.title'), { target: { value: 'Dentist again' } });

    const data = await savedData(onSave);
    expect('color' in data).toBe(false);
  });
});
