import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventModal, savedStatusFields } from '../event-modal';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// Status (confirmed / tentative / cancelled) in the event editor, #1909.
// Only the organizer sets it: an invitation the user received keeps the
// organizer's status.

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
  status: 'confirmed',
} as unknown as CalendarEvent;

const invitation = {
  ...event,
  id: 'e2',
  participants: {
    o: { '@type': 'Participant', name: 'Org', email: 'org@example.org', calendarAddress: 'mailto:org@example.org',
      roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
    me: { '@type': 'Participant', name: 'Me', email: 'me@example.org', calendarAddress: 'mailto:me@example.org',
      roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
  },
  organizerCalendarAddress: 'mailto:org@example.org',
  status: 'tentative',
} as unknown as CalendarEvent;

const select = (key: string) => document.querySelector(`select[id$="${key}"]`) as HTMLSelectElement | null;

async function savedData(onSave: ReturnType<typeof vi.fn>): Promise<Partial<CalendarEvent>> {
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0];
}

describe('savedStatusFields status', () => {
  it('saves a new event with the status picked, confirmed by default', () => {
    expect(savedStatusFields(null, { freeBusyStatus: 'busy' }).status).toBe('confirmed');
    expect(savedStatusFields(null, { freeBusyStatus: 'busy', status: 'tentative' }).status).toBe('tentative');
  });

  it('sends the status of an edit only when it changed', () => {
    expect('status' in savedStatusFields(event, { freeBusyStatus: 'busy', status: 'confirmed' })).toBe(false);
    expect(savedStatusFields(event, { freeBusyStatus: 'busy', status: 'cancelled' }).status).toBe('cancelled');
    // An event without STATUS counts as confirmed.
    const bare = { ...event, status: undefined } as unknown as CalendarEvent;
    expect('status' in savedStatusFields(bare, { freeBusyStatus: 'busy', status: 'confirmed' })).toBe(false);
    expect('status' in savedStatusFields(event, { freeBusyStatus: 'busy' })).toBe(false);
  });
});

describe('EventModal Status', () => {
  it('saves a new event as tentative', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal calendars={[own]} defaultDate={new Date('2026-11-20T10:00:00')} defaultCalendarId="own" onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('form.title'), { target: { value: 'Dentist' } });
    fireEvent.change(select('status')!, { target: { value: 'tentative' } });

    const data = await savedData(onSave);
    expect(data.status).toBe('tentative');
  });

  it('cancels an existing event and sends nothing else it did not change', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={event} startInEditMode calendars={[own]} onSave={onSave} onClose={vi.fn()} />);
    expect(select('status')!.value).toBe('confirmed');
    fireEvent.change(select('status')!, { target: { value: 'cancelled' } });

    const data = await savedData(onSave);
    expect(data.status).toBe('cancelled');
    expect('privacy' in data).toBe(false);
    expect('freeBusyStatus' in data).toBe(false);
  });

  it('sends no status when editing without changing it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={event} startInEditMode calendars={[own]} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('form.title'), { target: { value: 'Dentist (moved)' } });

    const data = await savedData(onSave);
    expect('status' in data).toBe(false);
  });

  it('offers no Status on an invitation the user received, and sends none', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={invitation} startInEditMode calendars={[own]} currentUserEmails={['me@example.org']} onSave={onSave} onClose={vi.fn()} />);
    expect(select('status')).toBeNull();
    fireEvent.change(select('show_as')!, { target: { value: 'free' } });

    const data = await savedData(onSave);
    expect('status' in data).toBe(false);
  });
});
