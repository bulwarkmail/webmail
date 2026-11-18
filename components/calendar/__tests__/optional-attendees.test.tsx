import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { suggestTimes } from '../find-a-time';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

// #1753: attendees are required or optional (JSCalendar roles.optional,
// iCalendar ROLE=OPT-PARTICIPANT on Stalwart 1.0 and 1.1).

vi.mock('../participant-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../participant-availability')>()),
  ParticipantAvailability: () => null,
}));

afterEach(cleanup);

const calendars = [{
  id: 'cal', name: 'Personal', color: '#123456', isDefault: true,
  myRights: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
  },
}] as unknown as Calendar[];

function person(address: string, roles: Record<string, boolean>, status = 'needs-action') {
  return {
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address, roles,
    participationStatus: status, scheduleAgent: 'server', expectReply: !roles.owner, kind: 'individual',
  };
}

function meeting(participants: Record<string, unknown>): CalendarEvent {
  return {
    id: 'e1', uid: 'u1', '@type': 'Event', title: 'Planning', description: '', start: '2026-10-12T10:00:00',
    duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { cal: true },
    organizerCalendarAddress: 'mailto:me@example.com', participants, alerts: null, recurrenceRules: null,
  } as unknown as CalendarEvent;
}

const own = () => meeting({
  org: person('me@example.com', { owner: true }, 'accepted'),
  bob: person('bob@example.org', { attendee: true }, 'accepted'),
  // Set in another client: chair and optional.
  carol: person('carol@example.org', { attendee: true, optional: true, chair: true }, 'tentative'),
});

async function edit(event: CalendarEvent, change: () => void = () => {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<EventModal event={event} calendars={calendars} onSave={onSave} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
  fireEvent.click(screen.getByText('events.edit'));
  change();
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0].participants as Record<string, CalendarParticipant>;
}

describe('optional attendees in the event editor', () => {
  it('keeps an attendee optional, and the roles the editor does not show, on a save of other changes', async () => {
    const participants = await edit(own(), () => {
      fireEvent.change(screen.getByDisplayValue('Planning'), { target: { value: 'Planning 2' } });
    });

    expect(participants.carol.roles).toEqual({ attendee: true, optional: true, chair: true });
    expect(participants.bob.roles).toEqual({ attendee: true });
  });

  it('marks an attendee optional, and required again, from their chip', async () => {
    const participants = await edit(own(), () => {
      const toggles = screen.getAllByTestId('participant-optional-toggle');
      expect(toggles.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
      fireEvent.click(toggles[0]); // bob: optional
      fireEvent.click(toggles[1]); // carol: required
    });

    expect(participants.bob.roles).toEqual({ attendee: true, optional: true });
    expect(participants.carol.roles).toEqual({ attendee: true, chair: true });
  });

  it('starts a new attendee as required', async () => {
    const participants = await edit(own(), () => {
      const field = screen.getByPlaceholderText('email_placeholder');
      fireEvent.change(field, { target: { value: 'dave@example.org' } });
      fireEvent.keyDown(field, { key: 'Enter' });
    });

    const dave = Object.values(participants).find((p) => p.email === 'dave@example.org');
    expect(dave?.roles).toEqual({ attendee: true });
  });

  it('shows who is optional in the event details', () => {
    render(<EventModal event={own()} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);

    const carol = screen.getByTitle('carol@example.org');
    expect(carol.textContent).toContain('participants.optional_role');
    expect(screen.getByTitle('bob@example.org').textContent).not.toContain('participants.optional_role');
  });

  it('offers no switch on someone else\'s invitation, but says who is optional', () => {
    const invitation = {
      ...meeting({
        boss: person('boss@example.org', { owner: true }, 'accepted'),
        me: person('me@example.com', { attendee: true, optional: true }),
      }),
      organizerCalendarAddress: 'mailto:boss@example.org',
    } as CalendarEvent;
    render(<EventModal event={invitation} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} currentUserEmails={['me@example.com']} />);
    fireEvent.click(screen.getByText('events.edit'));

    expect(screen.queryByTestId('participant-optional-toggle')).toBeNull();
    expect(screen.getByText('optional')).toBeInTheDocument();
  });
});

describe('optional attendees in Suggest times', () => {
  it('leaves an optional attendee\'s busy time out, and does not look it up', async () => {
    const calls: string[][] = [];
    const client = {
      getUsername: () => 'me@example.org',
      getAccountId: () => 'me',
      supportsAvailability: () => true,
      mayGetAvailability: async () => true,
      listPrincipals: async () => ({ status: 'ok', principals: [
        { id: 'me', type: 'individual', name: 'me', email: 'me@example.org' },
        { id: 'bob', type: 'individual', name: 'bob', email: 'bob@example.org' },
        { id: 'carol', type: 'individual', name: 'carol', email: 'carol@example.org' },
      ] }),
      getPrincipals: async () => [],
      getPrincipalsAvailability: async (ids: string[]) => {
        calls.push(ids);
        // Carol is busy all Monday morning, Berlin.
        return Object.fromEntries(ids.map((id) => [id, { periods: id === 'carol'
          ? [{ utcStart: '2026-11-02T08:00:00Z', utcEnd: '2026-11-02T11:00:00Z', busyStatus: 'confirmed' }]
          : [] }]));
      },
    } as unknown as IJMAPClient;

    const outcome = await suggestTimes(client, {
      attendees: [
        { name: 'Bob', email: 'bob@example.org' },
        { name: 'Carol', email: 'carol@example.org', optional: true },
      ],
      durationMs: 3600_000,
      now: new Date('2026-11-02T06:00:00Z'),
      timeZone: 'Europe/Berlin',
      workingDays: [1, 2, 3, 4, 5],
      dayStartHour: 9,
      dayEndHour: 17,
      visibleOwners: new Set(['bob@example.org', 'carol@example.org']),
    });

    expect(outcome.kind === 'ok' && outcome.result.slots[0].start.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(calls).toEqual([['me', 'bob']]);
  });
});
