import { act, render, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { useSettingsStore } from '@/stores/settings-store';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// The editor offers the availability grid (#1751) to the organiser of a timed
// event with attendees, and a time taken there moves the event.

type Props = {
  attendees: Array<{ email: string }>;
  start: Date | null;
  end: Date | null;
  onPick: (slot: { start: Date; end: Date }) => void;
  savedWindow?: { start: Date; end: Date } | null;
};
const renders: Props[] = [];
vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));
vi.mock('../find-a-time', () => ({ FindATime: () => null }));
vi.mock('../scheduling-assistant', () => ({
  SchedulingAssistant: (props: Props) => {
    renders.push(props);
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

const meeting = (organizer: string, extra: Partial<CalendarEvent> = {}) => ({
  id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '', start: '2026-09-10T10:00:00',
  duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { cal: true },
  organizerCalendarAddress: `mailto:${organizer}`,
  participants: {
    org: { '@type': 'Participant', name: 'Org', email: organizer, calendarAddress: `mailto:${organizer}`, roles: { owner: true }, participationStatus: 'accepted' },
    anna: { '@type': 'Participant', name: 'Anna', email: 'anna@example.com', calendarAddress: 'mailto:anna@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
    me: { '@type': 'Participant', name: 'Me', email: 'me@example.com', calendarAddress: 'mailto:me@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
  },
  alerts: null, recurrenceRules: null,
  ...extra,
}) as unknown as CalendarEvent;

describe('EventModal scheduling assistant', () => {
  afterEach(() => {
    useSettingsStore.setState({ timeZone: 'auto' });
    renders.length = 0;
  });

  it('is offered to the organiser, and a time taken there moves the event', () => {
    useSettingsStore.setState({ timeZone: 'Europe/Berlin' });
    render(<EventModal event={meeting('me@example.com')} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));
    const first = renders[renders.length - 1];
    expect(first).toBeDefined();
    expect(first.attendees.map((a) => a.email)).toContain('anna@example.com');
    // 10:00 in Berlin on 10 September is 08:00 UTC.
    expect(first.start?.toISOString()).toBe('2026-09-10T08:00:00.000Z');
    expect(first.savedWindow?.start.toISOString()).toBe('2026-09-10T08:00:00.000Z');

    act(() => first.onPick({ start: new Date('2026-09-11T12:30:00Z'), end: new Date('2026-09-11T14:00:00Z') }));
    const last = renders[renders.length - 1];
    expect(last.start?.toISOString()).toBe('2026-09-11T12:30:00.000Z');
    expect(last.end?.toISOString()).toBe('2026-09-11T14:00:00.000Z');
  });

  it('is not offered to an attendee, who can’t move the event', () => {
    render(<EventModal event={meeting('boss@example.com')} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    const edit = screen.queryByText('events.edit');
    if (edit) fireEvent.click(edit);
    expect(renders).toHaveLength(0);
  });
});
