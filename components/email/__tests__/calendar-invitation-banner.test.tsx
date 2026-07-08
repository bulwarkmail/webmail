import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarInvitationBanner } from '../calendar-invitation-banner';
import type { Email } from '@/lib/jmap/types';

const mocks = vi.hoisted(() => {
  const pushMock = vi.fn();
  const clientMock = {
    parseCalendarEvents: vi.fn(),
    getCalendarsAccountId: vi.fn(() => 'calendar-account'),
    getCalendarEvent: vi.fn(),
    queryCalendarEvents: vi.fn(async () => []),
  };

  const authState = {
    client: clientMock,
    primaryIdentity: { email: 'user@example.com' },
  };

  const settingsState = {
    calendarInvitationParsingEnabled: true,
  };

  const calendarState = {
    calendars: [{ id: 'cal-1', name: 'Primary', color: '#2563eb', isDefault: true }],
    supportsCalendar: true,
    importEvents: vi.fn(),
    rsvpEvent: vi.fn(),
    updateEvent: vi.fn(),
    events: [] as Array<Record<string, unknown>>,
    setSelectedDate: vi.fn(),
  };

  const useCalendarStoreMock = ((selector?: (state: typeof calendarState) => unknown) => (
    typeof selector === 'function' ? selector(calendarState) : calendarState
  )) as {
    (selector?: (state: typeof calendarState) => unknown): unknown;
    getState: () => typeof calendarState;
    setState: (updater: Partial<typeof calendarState> | ((state: typeof calendarState) => Partial<typeof calendarState> | typeof calendarState)) => void;
  };

  useCalendarStoreMock.getState = () => calendarState;
  useCalendarStoreMock.setState = (updater) => {
    const nextState = typeof updater === 'function' ? updater(calendarState) : updater;
    Object.assign(calendarState, nextState);
  };

  return {
    pushMock,
    clientMock,
    authState,
    settingsState,
    calendarState,
    useCalendarStoreMock,
  };
});

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    const strings: Record<string, string> = {
      loading: 'Loading event details…',
      title: 'Calendar Invitation',
      organizer: 'Organized by {name}',
      attendees: 'attendees',
      add_to_calendar: 'Add to calendar',
      added: 'Added to calendar',
      rsvp_sent: 'Response sent',
      already_in_calendar: 'Already in your calendar',
      your_response: 'Your response: {status}',
      response_accepted: 'Accepted',
      response_needed: 'Needs response',
      actor_response_info: '{name} responded {status}.',
      actor_sent_info: 'Sent by {name}.',
      actor_counter_info: '{name} proposed changes to this event.',
      actor_refresh_info: '{name} asked for the latest event details.',
      actor_declined_counter_info: '{name} declined the counter proposal.',
      actor_note: 'Note: {comment}',
      actor_unknown: 'Someone',
      sender_mismatch_unverified_info: 'This invitation was sent from {sender}, while the organizer listed in the calendar data is {organizer}, and the message could not be verified.',
      action_failed: 'Could not complete that calendar action.',
      proposal_applied: 'Proposed changes applied.',
      proposed_changes: 'Proposed changes',
      change_title: 'Title',
      change_time: 'Time',
      change_location: 'Location',
      change_description: 'Description',
      change_empty: 'None',
      change_from_to: '{before} -> {after}',
      apply_proposal: 'Apply proposed changes',
      review_proposal: 'Review proposal',
      review_request: 'Review request',
      view_in_calendar: 'View in calendar',
      organizer_role: 'You organize this event',
      accept: 'Accept',
      maybe: 'Maybe',
      decline: 'Decline',
      select_calendar: 'Select calendar',
    };

    let message = strings[key] ?? key;
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        message = message.replace(`{${name}}`, String(value));
      }
    }
    return message;
  },
  useFormatter: () => ({
    dateTime: (date: Date) => date.toISOString(),
  }),
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: mocks.pushMock }),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
}));

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (selector: (state: typeof mocks.settingsState) => unknown) => selector(mocks.settingsState),
}));

vi.mock('@/stores/calendar-store', () => ({
  useCalendarStore: mocks.useCalendarStoreMock,
}));

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    threadId: 'thread-1',
    mailboxIds: { inbox: true },
    keywords: {},
    size: 512,
    receivedAt: '2026-03-16T10:00:00Z',
    hasAttachment: true,
    attachments: [
      {
        partId: '1',
        blobId: 'blob-1',
        size: 256,
        type: 'text/calendar; method=REQUEST',
        name: 'invite.ics',
      },
    ],
    ...overrides,
  };
}

describe('CalendarInvitationBanner', () => {
  beforeEach(() => {
    mocks.pushMock.mockReset();
    mocks.settingsState.calendarInvitationParsingEnabled = true;
    mocks.clientMock.parseCalendarEvents.mockReset();
    mocks.clientMock.getCalendarEvent.mockReset();
    mocks.clientMock.getCalendarEvent.mockResolvedValue(null);
    mocks.clientMock.queryCalendarEvents.mockReset();
    mocks.clientMock.queryCalendarEvents.mockResolvedValue([]);
    mocks.calendarState.importEvents.mockReset();
    mocks.calendarState.rsvpEvent.mockReset();
    mocks.calendarState.updateEvent.mockReset();
    mocks.calendarState.setSelectedDate.mockReset();
    mocks.calendarState.events = [];
  });

  it('does not parse invitations when invitation parsing is disabled', () => {
    mocks.settingsState.calendarInvitationParsingEnabled = false;

    const { container } = render(<CalendarInvitationBanner email={makeEmail()} />);

    expect(container.firstChild).toBeNull();
    expect(mocks.clientMock.parseCalendarEvents).not.toHaveBeenCalled();
  });

  it('does not show trust warnings on sent invitations from the current user', async () => {
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-sent',
        title: 'My Sent Invite',
        start: '2026-03-22T14:00:00Z',
        organizerCalendarAddress: 'mailto:other-organizer@example.com',
        participants: {
          organizer: {
            '@type': 'Participant',
            calendarAddress: 'mailto:other-organizer@example.com',
            name: 'Other Organizer',
            roles: { owner: true },
            participationStatus: 'accepted',
          },
          attendee: {
            '@type': 'Participant',
            email: 'guest@example.com',
            name: 'Guest',
            roles: { attendee: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ]);

    render(
      <CalendarInvitationBanner
        email={makeEmail({
          id: 'email-sent',
          from: [{ email: 'user@example.com', name: 'User' }],
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'My Sent Invite' })).toBeInTheDocument();
    });

    expect(screen.queryByText(/sent from/i)).not.toBeInTheDocument();
  });

  it('shows existing event status, current response, and view-in-calendar action', async () => {
    mocks.calendarState.events = [
      {
        id: 'event-1',
        uid: 'uid-1',
        start: '2026-03-20T09:00:00Z',
        participants: {
          attendee: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { attendee: true },
            participationStatus: 'accepted',
          },
        },
      },
    ];

    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-1',
        title: 'Team Sync',
        start: '2026-03-20T09:00:00Z',
        participants: {
          attendee: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { attendee: true },
            participationStatus: 'accepted',
          },
        },
      },
    ]);

    render(<CalendarInvitationBanner email={makeEmail()} />);

    await waitFor(() => {
      expect(screen.getByText('Already in your calendar')).toBeInTheDocument();
    });

    expect(screen.getByText('Your response: Accepted')).toBeInTheDocument();

    fireEvent.click(screen.getByText('View in calendar'));

    expect(mocks.calendarState.setSelectedDate).toHaveBeenCalledTimes(1);
    expect(mocks.pushMock).toHaveBeenCalledWith('/calendar');
  });

  it('keeps the invitation summary visible after importing', async () => {
    mocks.calendarState.importEvents.mockResolvedValue(1);
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-2',
        title: 'Planning Session',
        start: '2026-03-22T13:00:00Z',
        participants: {
          attendee: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { attendee: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ]);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-2' })} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Planning Session' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add to calendar'));

    await waitFor(() => {
      expect(screen.getByText('Added to calendar')).toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { name: 'Planning Session' })).toBeInTheDocument();
  });

  it('does not show RSVP actions when the current user is the organizer', async () => {
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-3',
        title: 'Organizer Review',
        start: '2026-03-25T11:00:00Z',
        participants: {
          organizer: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { owner: true },
            participationStatus: 'accepted',
          },
          attendee: {
            '@type': 'Participant',
            email: 'alice@example.com',
            name: 'Alice',
            roles: { attendee: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ]);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-3' })} />);

    await waitFor(() => {
      expect(screen.getByText('You organize this event')).toBeInTheDocument();
    });

    expect(screen.queryByText('Accept')).not.toBeInTheDocument();
    expect(screen.queryByText('Maybe')).not.toBeInTheDocument();
    expect(screen.queryByText('Decline')).not.toBeInTheDocument();
  });

  it('keeps the banner visible when an import action fails', async () => {
    mocks.calendarState.importEvents.mockResolvedValue(0);
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-4',
        title: 'Failed Import Event',
        start: '2026-03-26T15:00:00Z',
        participants: {
          attendee: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { attendee: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ]);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-4' })} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Failed Import Event' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add to calendar'));

    await waitFor(() => {
      expect(screen.getByText('Could not complete that calendar action.')).toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { name: 'Failed Import Event' })).toBeInTheDocument();
  });

  it('hydrates sparse existing events before sending RSVP', async () => {
    mocks.calendarState.events = [
      {
        id: 'event-6',
        uid: 'uid-6',
        start: '2026-03-28T09:00:00Z',
      },
    ];

    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-6',
        title: 'Sparse Event',
        start: '2026-03-28T09:00:00Z',
        participants: {
          parsedAttendee: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { required: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ]);

    mocks.clientMock.getCalendarEvent.mockResolvedValue({
      id: 'event-6',
      uid: 'uid-6',
      start: '2026-03-28T09:00:00Z',
      participants: {
        canonicalAttendee: {
          '@type': 'Participant',
          email: 'user@example.com',
          name: 'User',
          roles: { attendee: true },
          participationStatus: 'needs-action',
        },
      },
    });
    mocks.calendarState.rsvpEvent.mockResolvedValue(undefined);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-6' })} />);

    await waitFor(() => {
      expect(screen.getByText('Accept')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Accept'));

    await waitFor(() => {
      expect(mocks.clientMock.getCalendarEvent).toHaveBeenCalledWith('event-6');
    });

    expect(mocks.calendarState.rsvpEvent).toHaveBeenCalledWith(
      mocks.clientMock,
      'event-6',
      'canonicalAttendee',
      'accepted',
      null,
    );
  });

  it('falls back to organizerCalendarAddress when replyTo is missing', async () => {
    mocks.calendarState.events = [
      {
        id: 'event-7',
        uid: 'uid-7',
        start: '2026-03-29T09:00:00Z',
        participants: {
          attendee: {
            '@type': 'Participant',
            calendarAddress: 'mailto:user@example.com',
            name: 'User',
            roles: { attendee: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ];

    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-7',
        title: 'Invite Without Reply-To',
        start: '2026-03-29T09:00:00Z',
        organizerCalendarAddress: 'mailto:organizer@example.com',
        participants: {
          attendee: {
            '@type': 'Participant',
            calendarAddress: 'mailto:user@example.com',
            name: 'User',
            roles: { required: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ]);
    mocks.calendarState.rsvpEvent.mockResolvedValue(undefined);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-7' })} />);

    await waitFor(() => {
      expect(screen.getByText('Accept')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Accept'));

    await waitFor(() => {
      expect(mocks.calendarState.rsvpEvent).toHaveBeenCalledWith(
        mocks.clientMock,
        'event-7',
        'attendee',
        'accepted',
        { imip: 'mailto:organizer@example.com' },
      );
    });
  });

  it('repairs sparse existing events with parsed participants before RSVPing', async () => {
    mocks.calendarState.events = [
      {
        id: 'event-8',
        uid: 'uid-8',
        start: '2026-03-30T09:00:00Z',
      },
    ];

    mocks.clientMock.getCalendarEvent.mockResolvedValue({
      id: 'event-8',
      uid: 'uid-8',
      start: '2026-03-30T09:00:00Z',
    });
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-8',
        title: 'Sparse Stored Event',
        start: '2026-03-30T09:00:00Z',
        organizerCalendarAddress: 'mailto:organizer@example.com',
        participants: {
          organizer: {
            '@type': 'Participant',
            calendarAddress: 'mailto:organizer@example.com',
            name: 'Organizer',
            roles: { required: true },
            participationStatus: 'accepted',
          },
          attendee: {
            '@type': 'Participant',
            calendarAddress: 'mailto:user@example.com',
            name: 'User',
            roles: { required: true },
            participationStatus: 'needs-action',
          },
        },
      },
    ]);
    mocks.calendarState.updateEvent.mockResolvedValue(undefined);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-8' })} />);

    await waitFor(() => {
      expect(screen.getByText('Accept')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Accept'));

    await waitFor(() => {
      expect(mocks.calendarState.updateEvent).toHaveBeenCalledWith(
        mocks.clientMock,
        'event-8',
        expect.objectContaining({
          // The stored event lacks an ORGANIZER, so the RSVP repair writes
          // organizerCalendarAddress (replyTo is retired in jscalendarbis).
          organizerCalendarAddress: 'mailto:organizer@example.com',
          participants: expect.objectContaining({
            attendee: expect.objectContaining({
              participationStatus: 'accepted',
            }),
          }),
        }),
        true,
      );
    });

    expect(mocks.calendarState.rsvpEvent).not.toHaveBeenCalled();
  });

  it('shows counter changes and lets organizers apply the proposal', async () => {
    mocks.calendarState.updateEvent = vi.fn().mockResolvedValue(undefined);
    mocks.calendarState.events = [
      {
        id: 'event-5',
        uid: 'uid-5',
        title: 'Original Sync',
        start: '2026-03-27T09:00:00Z',
        duration: 'PT1H',
        locations: {
          room: { '@type': 'Location', name: 'Room A' },
        },
        participants: {
          organizer: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { owner: true },
            participationStatus: 'accepted',
          },
          attendee: {
            '@type': 'Participant',
            email: 'alice@example.com',
            name: 'Alice',
            roles: { attendee: true },
            participationStatus: 'tentative',
            participationComment: 'Could we move this later?',
          },
        },
      },
    ];

    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      {
        uid: 'uid-5',
        title: 'Original Sync',
        start: '2026-03-27T10:00:00Z',
        duration: 'PT1H',
        locations: {
          room: { '@type': 'Location', name: 'Room B' },
        },
        participants: {
          organizer: {
            '@type': 'Participant',
            email: 'user@example.com',
            name: 'User',
            roles: { owner: true },
            participationStatus: 'accepted',
          },
          attendee: {
            '@type': 'Participant',
            email: 'alice@example.com',
            name: 'Alice',
            roles: { attendee: true },
            participationStatus: 'tentative',
            participationComment: 'Could we move this later?',
          },
        },
      },
    ]);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-5', attachments: [{ partId: '1', blobId: 'blob-5', size: 256, type: 'text/calendar; method=COUNTER', name: 'counter.ics' }] })} />);

    await waitFor(() => {
      expect(screen.getByText('Proposed changes')).toBeInTheDocument();
    });

    expect(screen.getByText(/Location/)).toBeInTheDocument();
    expect(screen.getByText('Review proposal')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Apply proposed changes'));

    await waitFor(() => {
      expect(mocks.calendarState.updateEvent).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('Proposed changes applied.')).toBeInTheDocument();
  });
});