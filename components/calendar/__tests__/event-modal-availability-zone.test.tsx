import { render, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { useSettingsStore } from '@/stores/settings-store';
import { getBrowserTimeZone } from '@/lib/timezone';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// The event form's fields are a wall clock in the user's effective time
// zone (the save path labels them with it). The attendees' free/busy must be
// asked for the same instants, not for the wall clock read in the browser's
// own zone.

const windows: Array<{ start: Date | null; end: Date | null }> = [];
vi.mock('../participant-availability', () => ({
  ParticipantAvailability: (props: { start: Date | null; end: Date | null }) => {
    windows.push({ start: props.start, end: props.end });
    return null;
  },
}));

const calendars = [{
  id: 'cal', name: 'Work', color: '#123456', isDefault: true,
  myRights: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
  },
}] as unknown as Calendar[];

const meeting = {
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '', start: '2026-09-10T10:00:00',
  duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { cal: true },
  organizerCalendarAddress: 'mailto:me@example.com',
  participants: {
    org: { '@type': 'Participant', name: 'Me', email: 'me@example.com', calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
    anna: { '@type': 'Participant', name: 'Anna', email: 'anna@example.com', calendarAddress: 'mailto:anna@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
  },
  alerts: null, recurrenceRules: null,
} as unknown as CalendarEvent;

describe('EventModal attendee availability window', () => {
  afterEach(() => {
    useSettingsStore.setState({ timeZone: 'auto' });
    windows.length = 0;
  });

  it('asks for the event instants when the display zone is not the browser zone', () => {
    // A zone the browser running the test is not in.
    const zone = getBrowserTimeZone() === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo';
    useSettingsStore.setState({ timeZone: zone });
    render(
      <EventModal event={meeting} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />,
    );
    fireEvent.click(screen.getByText('events.edit'));
    const last = windows[windows.length - 1];
    // 10:00 in Berlin on 10 September (summer time) is 08:00 UTC.
    expect(last.start?.toISOString()).toBe('2026-09-10T08:00:00.000Z');
    expect(last.end?.toISOString()).toBe('2026-09-10T09:00:00.000Z');
  });
});
