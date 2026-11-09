import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventModal } from '../event-modal';
import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import { AUTO_TIME_ZONE } from '@/lib/timezone';
import { useSettingsStore } from '@/stores/settings-store';
import { getEventStartDate } from '@/lib/calendar-utils';

// The editor rewrote the organizer on every save of an event with attendees,
// to the user's first address, and put every attendee back to needs-action.
// An invitation the user saved in their own calendar became the user's, and
// their answer was gone. It now keeps the event's organizer and the answers
// of attendees who stay.

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const calendars = [{
  id: 'cal', name: 'Personal', color: '#123456', isDefault: true,
  myRights: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
  },
}] as unknown as Calendar[];

// Participants as each version stores them: 0.16.23 drops an attendee's
// roles, 1.0 keeps them.
function participant(version: '0.16' | '1.0', address: string, owner: boolean, status: string) {
  return {
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address,
    ...(owner ? { roles: { owner: true } } : version === '1.0' ? { roles: { attendee: true } } : {}),
    participationStatus: status, scheduleAgent: 'server', expectReply: !owner, kind: 'individual',
  };
}

function meeting(organizer: string, participants: Record<string, unknown>): CalendarEvent {
  return {
    id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '', start: '2026-10-12T10:00:00',
    duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { cal: true },
    organizerCalendarAddress: `mailto:${organizer}`, participants, alerts: null, recurrenceRules: null,
  } as unknown as CalendarEvent;
}

async function saveUnchanged(event: CalendarEvent, onSave = vi.fn().mockResolvedValue(undefined)): Promise<Partial<CalendarEvent>> {
  render(
    <EventModal
      event={event}
      calendars={calendars}
      onSave={onSave}
      onClose={vi.fn()}
      currentUserEmails={['me@example.com']}
    />,
  );
  fireEvent.click(screen.getByText('events.edit'));
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0] as Partial<CalendarEvent>;
}

describe.each<['0.16' | '1.0']>([['0.16'], ['1.0']])('EventModal organizer and answers on Stalwart %s', (version) => {
  const invitation = () => meeting('boss@example.org', {
    boss: participant(version, 'boss@example.org', true, 'accepted'),
    mine: participant(version, 'me@example.com', false, 'accepted'),
    bob: participant(version, 'bob@example.org', false, 'declined'),
  });

  // The user's own copy of someone else's meeting: a save (an alert, a note)
  // used to rewrite the participants and send the organizer a reply.
  it('leaves the participants of an invitation alone and sends no messages', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const data = await saveUnchanged(invitation(), onSave);

    expect(data).not.toHaveProperty('participants');
    expect(data).not.toHaveProperty('organizerCalendarAddress');
    expect(onSave.mock.calls[0][1]).toBe(false);
  });

  it('offers no invitations and no attendee changes on an invitation', () => {
    render(<EventModal event={invitation()} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));

    expect(screen.queryByText('participants.send_invitations')).toBeNull();
    expect(screen.getByPlaceholderText('email_placeholder')).toBeDisabled();
  });

  it('offers both on the user\'s own meeting', () => {
    const own = meeting('me@example.com', {
      org: participant(version, 'me@example.com', true, 'accepted'),
      bob: participant(version, 'bob@example.org', false, 'declined'),
    });
    render(<EventModal event={own} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));

    expect(screen.getByText('participants.send_invitations')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('email_placeholder')).toBeEnabled();
  });

  it('keeps the letter case a series is organized under', async () => {
    const data = await saveUnchanged(meeting('ME@Example.com', {
      org: participant(version, 'ME@Example.com', true, 'accepted'),
      guest: participant(version, 'guest@example.net', false, 'tentative'),
    }));

    expect(data).not.toHaveProperty('organizerCalendarAddress');
    const participants = data.participants as Record<string, CalendarParticipant>;
    expect(participants.org.calendarAddress).toBe('mailto:ME@Example.com');
    expect(participants.guest.participationStatus).toBe('tentative');
  });
});

// RFC 5546: when the organizer moves an event, the attendees are asked
// again; every other save keeps their answers. The editor shows and writes
// the event on its own clock (New York), whatever the user's zone (here
// Tokyo, UTC+9) is (pim-2).
describe.each<['0.16' | '1.0']>([['0.16'], ['1.0']])('EventModal answers after a move on Stalwart %s', (version) => {
  beforeEach(() => useSettingsStore.setState({ timeZone: 'Asia/Tokyo' }));
  afterEach(() => useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE }));

  // 08:00-09:00 in New York (UTC-4 in October): 21:00-22:00 in Tokyo.
  function inNewYork(organizer: string, participants: Record<string, unknown>): CalendarEvent {
    return {
      ...meeting(organizer, participants),
      start: '2026-10-12T08:00:00', timeZone: 'America/New_York',
      utcStart: '2026-10-12T12:00:00Z', utcEnd: '2026-10-12T13:00:00Z',
    } as CalendarEvent;
  }
  const own = () => inNewYork('me@example.com', {
    org: participant(version, 'me@example.com', true, 'accepted'),
    bob: participant(version, 'bob@example.org', false, 'accepted'),
    carol: participant(version, 'carol@example.org', false, 'declined'),
  });

  async function save(event: CalendarEvent, edit: (container: HTMLElement) => void): Promise<Partial<CalendarEvent>> {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <EventModal event={event} calendars={calendars} onSave={onSave} onClose={vi.fn()} currentUserEmails={['me@example.com']} />,
    );
    fireEvent.click(screen.getByText('events.edit'));
    edit(container);
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    return onSave.mock.calls[0][0] as Partial<CalendarEvent>;
  }
  const moveStartTo = (time: string) => (container: HTMLElement) => {
    const [startTime] = container.querySelectorAll('input[type="time"]');
    fireEvent.change(startTime, { target: { value: time } });
  };
  const statuses = (data: Partial<CalendarEvent>) => Object.fromEntries(
    Object.entries(data.participants as Record<string, CalendarParticipant>).map(([id, p]) => [id, p.participationStatus]),
  );

  it('asks the attendees again when the user moves their event', async () => {
    const data = await save(own(), moveStartTo('22:00'));

    expect(data.start).toBe('2026-10-12T22:00:00');
    expect(statuses(data)).toEqual({ org: 'accepted', bob: 'needs-action', carol: 'needs-action' });
  });

  it('keeps the answers, and the event in its own zone, when nothing changes', async () => {
    const data = await save(own(), () => {});

    // Written in its own zone, as it was (pim-2); it was rewritten into the user's.
    expect(data).toMatchObject({ start: '2026-10-12T08:00:00', timeZone: 'America/New_York', duration: 'PT1H' });
    expect(statuses(data)).toEqual({ org: 'accepted', bob: 'accepted', carol: 'declined' });
  });

  it('keeps the answers when the title changes', async () => {
    const data = await save(own(), () => {
      fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Planning, room 2' } });
    });

    expect(data.title).toBe('Planning, room 2');
    expect(statuses(data)).toEqual({ org: 'accepted', bob: 'accepted', carol: 'declined' });
  });

  it('never asks again when the user did not organize the event', async () => {
    const invitation = inNewYork('boss@example.org', {
      boss: participant(version, 'boss@example.org', true, 'accepted'),
      mine: participant(version, 'me@example.com', false, 'accepted'),
      bob: participant(version, 'bob@example.org', false, 'declined'),
    });

    const data = await save(invitation, moveStartTo('22:00'));

    // The user's own copy moves; the organizer's participants stay as they are.
    expect(data.start).toBe('2026-10-12T22:00:00');
    expect(data).not.toHaveProperty('participants');
  });

  // A series that happens on other days is a move as well.
  const weekly = (rule: Record<string, unknown>, extra: Partial<CalendarEvent> = {}) => ({
    ...own(), recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', ...rule }], ...extra,
  }) as CalendarEvent;
  // The recurrence dropdown, found by the option it shows.
  const pickRecurrence = (from: string, to: string) => (container: HTMLElement) => {
    const select = Array.from(container.querySelectorAll('select')).find((element) => element.value === from)!;
    fireEvent.change(select, { target: { value: to } });
  };

  it('asks the attendees again when the user gives their series another rule', async () => {
    const data = await save(weekly({}), pickRecurrence('weekly', 'daily'));

    expect(statuses(data)).toEqual({ org: 'accepted', bob: 'needs-action', carol: 'needs-action' });
  });

  it('keeps the answers when the user leaves a custom rule alone', async () => {
    // A custom rule as 1.0 returns it: typed NDay, no interval.
    const custom = weekly({ byDay: [{ '@type': 'NDay', day: 'mo' }], count: 5 });
    const touched = await save(custom, pickRecurrence('custom', 'weekly'));
    cleanup();
    const untouched = await save(custom, () => {});

    // Switched to a plain weekly rule: a change.
    expect(statuses(touched)).toEqual({ org: 'accepted', bob: 'needs-action', carol: 'needs-action' });
    expect(statuses(untouched)).toEqual({ org: 'accepted', bob: 'accepted', carol: 'declined' });
  });

  it('keeps the answers when a rule is changed on one occurrence, where it does not apply', async () => {
    const occurrence = weekly({}, { recurrenceId: '2026-10-12T08:00:00' });

    const data = await save(occurrence, pickRecurrence('weekly', 'daily'));

    expect(statuses(data)).toEqual({ org: 'accepted', bob: 'accepted', carol: 'declined' });
  });

  it('keeps an event that lasts no time as it is, answers included', async () => {
    const deadline = { ...own(), duration: 'PT0M', utcEnd: '2026-10-12T12:00:00Z' } as CalendarEvent;

    const data = await save(deadline, () => {});

    expect(data.duration).toBe('PT0M');
    expect(statuses(data)).toEqual({ org: 'accepted', bob: 'accepted', carol: 'declined' });
  });
});

// userc shares a calendar with the user (read & write) and organizes a
// meeting in it. Stalwart sends a change to it from userc, the owner of the
// account (isOrigin: true, live on both versions). The editor treated the
// user as an attendee there: no participants written, no "Send
// invitations", the attendees never told of a move.
describe.each<['0.16' | '1.0']>([['0.16'], ['1.0']])('EventModal on the owner\'s meeting in a shared calendar on Stalwart %s', (version) => {
  const shared = [{
    id: 'f:bz', originalId: 'bz', name: 'Team', color: '#3366cc', isShared: true, accountId: 'f',
    myRights: {
      mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
      mayUpdatePrivate: true, mayRSVP: true, mayShare: false, mayDelete: false,
    },
  }] as unknown as Calendar[];
  // The user (userb) attends the meeting as well.
  const inShared = (organizer: string, isOrigin: boolean) => ({
    ...meeting(organizer, {
      owner: participant(version, organizer, true, 'accepted'),
      anna: participant(version, 'usera@example.org', false, 'accepted'),
      bea: participant(version, 'userb@example.org', false, 'tentative'),
    }),
    id: 'f:fj', calendarIds: { 'f:bz': true }, isShared: true, accountId: 'f', isOrigin,
  }) as CalendarEvent;

  async function saveAs(event: CalendarEvent, edit: (container: HTMLElement) => void = () => {}) {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <EventModal event={event} calendars={shared} onSave={onSave} onClose={vi.fn()} currentUserEmails={['userb@example.org']} />,
    );
    fireEvent.click(screen.getByText('events.edit'));
    edit(container);
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    return { data: onSave.mock.calls[0][0] as Partial<CalendarEvent>, send: onSave.mock.calls[0][1] };
  }

  it('writes the owner\'s participants, the user among them, and sends the change', async () => {
    const { data, send } = await saveAs(inShared('userc@example.org', true));

    const participants = data.participants as Record<string, CalendarParticipant>;
    expect(participants.owner).toMatchObject({ calendarAddress: 'mailto:userc@example.org', roles: { owner: true } });
    expect(Object.keys(participants).sort()).toEqual(['anna', 'bea', 'owner']);
    expect(participants.bea.participationStatus).toBe('tentative');
    expect(data).not.toHaveProperty('organizerCalendarAddress');
    expect(send).toBe(true);
  });

  it('offers invitations and attendee changes', () => {
    render(<EventModal event={inShared('userc@example.org', true)} calendars={shared} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['userb@example.org']} />);
    fireEvent.click(screen.getByText('events.edit'));

    expect(screen.getByText('participants.send_invitations')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('email_placeholder')).toBeEnabled();
  });

  // 0.16 sends userb nothing of her own move (her address counts as the
  // account's own): reset, her answer stayed needs-action in userc's copy
  // (live on 0.16.23).
  it('asks the other attendees again when the user moves it, and keeps the user\'s answer', async () => {
    const { data } = await saveAs(inShared('userc@example.org', true), (container) => {
      const [startTime] = container.querySelectorAll('input[type="time"]');
      fireEvent.change(startTime, { target: { value: '11:00' } });
    });

    const participants = data.participants as Record<string, CalendarParticipant>;
    expect(participants.owner.participationStatus).toBe('accepted');
    expect(participants.anna.participationStatus).toBe('needs-action');
    expect(participants.bea.participationStatus).toBe('tentative');
  });

  it('leaves an invitation the owner got alone', async () => {
    const { data, send } = await saveAs(inShared('boss@example.org', false));

    expect(data).not.toHaveProperty('participants');
    expect(send).toBe(false);
  });
});

// A save for every occurrence of a series applies what the user changed on
// the occurrence the editor shows (lib/recurrence-scope-edit.ts): the save
// carries the attendees the editor opened and saved with, and its dates.
describe('EventModal editor state on save', () => {
  it('passes the attendees it opened with, those it saved with, and when the event happens', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const event = meeting('me@example.com', {
      org: participant('1.0', 'me@example.com', true, 'accepted'),
      bob: participant('1.0', 'bob@example.org', false, 'accepted'),
    });
    render(<EventModal event={event} calendars={calendars} onSave={onSave} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));
    fireEvent.change(screen.getByPlaceholderText('email_placeholder'), { target: { value: 'carol@example.org' } });
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const editor = onSave.mock.calls[0][2];
    expect(editor.initialAttendees).toEqual([{ name: '', email: 'bob@example.org' }]);
    expect(editor.attendees).toEqual([{ name: '', email: 'bob@example.org' }, { name: '', email: 'carol@example.org' }]);
    expect(editor.when.allDay).toBe(false);
    expect(editor.when.start.getTime()).toBe(getEventStartDate(event).getTime());
    expect(editor.when.end.getTime() - editor.when.start.getTime()).toBe(3_600_000);
  });
});
