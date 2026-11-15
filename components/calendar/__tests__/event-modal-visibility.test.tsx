import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// Show as (busy/free) and Visibility (public/private/secret) in the event
// editor, #1712. Only the calendar's owner may set privacy, so a calendar
// shared with the user offers no Visibility field.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const rights = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const own = { id: 'own', name: 'Personal', color: '#123456', isDefault: true, myRights: rights } as unknown as Calendar;
const shared = { ...own, id: 'shared', name: 'Team', isDefault: false, isShared: true } as unknown as Calendar;

const event = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Dentist', description: '', start: '2026-11-20T10:00:00',
  duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { own: true },
  participants: null, alerts: null, recurrenceRules: null, freeBusyStatus: 'busy', privacy: 'public',
} as unknown as CalendarEvent;

const select = (key: string) => document.querySelector(`select[id$="${key}"]`) as HTMLSelectElement | null;

async function savedData(onSave: ReturnType<typeof vi.fn>): Promise<Partial<CalendarEvent>> {
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0];
}

describe('EventModal Show as and Visibility', () => {
  it('saves a new event as free and private', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal calendars={[own]} defaultDate={new Date('2026-11-20T10:00:00')} defaultCalendarId="own" onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('form.title'), { target: { value: 'Dentist' } });
    fireEvent.change(select('show_as')!, { target: { value: 'free' } });
    fireEvent.change(select('visibility')!, { target: { value: 'private' } });

    const data = await savedData(onSave);
    expect(data).toMatchObject({ freeBusyStatus: 'free', privacy: 'private' });
  });

  it('sends only the changed visibility when editing', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={event} startInEditMode calendars={[own]} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(select('visibility')!, { target: { value: 'secret' } });

    const data = await savedData(onSave);
    expect(data.privacy).toBe('secret');
    expect('freeBusyStatus' in data).toBe(false);
  });

  it('offers no Visibility in a calendar shared with the user, and sends none', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const theirs = { ...event, calendarIds: { shared: true }, privacy: 'private' } as CalendarEvent;
    render(<EventModal event={theirs} startInEditMode calendars={[shared]} onSave={onSave} onClose={vi.fn()} />);
    expect(select('visibility')).toBeNull();
    fireEvent.change(select('show_as')!, { target: { value: 'free' } });

    const data = await savedData(onSave);
    expect(data.freeBusyStatus).toBe('free');
    expect('privacy' in data).toBe(false);
  });

  it('shows a free, private event as such in its summary', () => {
    const quiet = { ...event, freeBusyStatus: 'free', privacy: 'private' } as CalendarEvent;
    render(<EventModal event={quiet} calendars={[own]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('event-visibility').textContent).toBe('form.shown_free · form.visibility_private');
  });
});
