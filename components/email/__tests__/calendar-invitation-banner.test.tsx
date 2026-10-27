import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarInvitationBanner } from '../calendar-invitation-banner';
import type { Email } from '@/lib/jmap/types';
import { jmapSetError } from '@/lib/jmap/jmap-error';

const mocks = vi.hoisted(() => {
  const pushMock = vi.fn();
  const clientMock = {
    parseCalendarEvents: vi.fn(),
    getAccountId: vi.fn(() => 'mail-account'),
    getCalendarsAccountId: vi.fn(() => 'calendar-account'),
    getCalendarEvent: vi.fn(),
    queryCalendarEvents: vi.fn(async () => []),
  };

  const sourceClientMock = {
    parseCalendarEvents: vi.fn(),
    fetchBlob: vi.fn(),
    getAccountId: vi.fn(() => 'source-mail-account'),
    getCalendarsAccountId: vi.fn(() => 'source-calendar-account'),
  };

  const authState = {
    client: clientMock,
    primaryIdentity: { email: 'user@example.com' },
    identities: [{ email: 'user@example.com' }] as Array<{ email: string }>,
    getClientForAccount: vi.fn((id: string) => (id === 'login-b' ? sourceClientMock : undefined)),
  };

  const emailState = {
    viewingAccountId: null as string | null,
    selectedMailbox: 'inbox',
    mailboxes: [] as Array<Record<string, unknown>>,
    accountMailboxes: {} as Record<string, Array<Record<string, unknown>>>,
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
    sourceClientMock,
    authState,
    emailState,
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
      attendee_mismatch_unverified_info: 'This response was sent from {sender}, while the attendee answering in the calendar data is {attendee}, and the message could not be verified.',
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
      participant_limit: 'The server allows at most {max} participants per event.',
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

vi.mock('@/stores/email-store', () => ({
  useEmailStore: (selector: (state: typeof mocks.emailState) => unknown) => selector(mocks.emailState),
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
    mocks.sourceClientMock.parseCalendarEvents.mockReset();
    mocks.sourceClientMock.fetchBlob.mockReset();
    mocks.sourceClientMock.fetchBlob.mockRejectedValue(new Error('no blob'));
    mocks.authState.getClientForAccount.mockClear();
    mocks.authState.identities = [{ email: 'user@example.com' }];
    mocks.emailState.viewingAccountId = null;
    mocks.emailState.selectedMailbox = 'inbox';
    mocks.emailState.mailboxes = [];
    mocks.emailState.accountMailboxes = {};
  });

  it('does not parse invitations when invitation parsing is disabled', () => {
    mocks.settingsState.calendarInvitationParsingEnabled = false;

    const { container } = render(<CalendarInvitationBanner email={makeEmail()} />);

    expect(container.firstChild).toBeNull();
    expect(mocks.clientMock.parseCalendarEvents).not.toHaveBeenCalled();
  });

  // #867: blobs are per-account, so a message from another signed-in account
  // must be parsed through that account's client and against its owning
  // JMAP account - not the globally active login.
  it('parses invitations of a stamped (unified view) email through its source account', async () => {
    mocks.sourceClientMock.parseCalendarEvents.mockResolvedValue([
      { uid: 'uid-b', title: 'Invite in account B', start: '2026-03-22T14:00:00Z', participants: {} },
    ]);

    render(
      <CalendarInvitationBanner
        email={makeEmail({ sourceClientAccountId: 'login-b', sourceAccountId: 'jmap-b' })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Invite in account B')).toBeInTheDocument();
    });
    expect(mocks.sourceClientMock.parseCalendarEvents).toHaveBeenCalledWith('jmap-b', 'blob-1');
    expect(mocks.sourceClientMock.fetchBlob).toHaveBeenCalledWith('blob-1', 'invite.ics', 'text/calendar', 'jmap-b');
    expect(mocks.clientMock.parseCalendarEvents).not.toHaveBeenCalled();
  });

  it('parses invitations through the viewing account in the per-account sidebar view', async () => {
    mocks.emailState.viewingAccountId = 'login-b';
    mocks.sourceClientMock.parseCalendarEvents.mockResolvedValue([
      { uid: 'uid-b', title: 'Invite in account B', start: '2026-03-22T14:00:00Z', participants: {} },
    ]);

    render(<CalendarInvitationBanner email={makeEmail()} />);

    await waitFor(() => {
      expect(screen.getByText('Invite in account B')).toBeInTheDocument();
    });
    // Unstamped email: the owning account is the viewing client's own mail account.
    expect(mocks.sourceClientMock.parseCalendarEvents).toHaveBeenCalledWith('source-mail-account', 'blob-1');
    expect(mocks.clientMock.parseCalendarEvents).not.toHaveBeenCalled();
  });

  // Emails opened directly in a shared/group folder (the "Shared" sidebar
  // section) are undecorated but live in the folder owner's account, reached
  // through the active client - same rule as the store's resolveViewAccountId.
  it('parses invitations in a directly viewed shared folder against the folder owner', async () => {
    mocks.emailState.selectedMailbox = 'owner-x:x-inbox';
    mocks.emailState.mailboxes = [
      { id: 'inbox', name: 'Inbox' },
      { id: 'owner-x:x-inbox', name: 'Inbox', isShared: true, accountId: 'owner-x' },
    ];
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      { uid: 'uid-x', title: 'Invite in shared folder', start: '2026-03-22T14:00:00Z', participants: {} },
    ]);

    render(<CalendarInvitationBanner email={makeEmail({ mailboxIds: { 'owner-x:x-inbox': true } })} />);

    await waitFor(() => {
      expect(screen.getByText('Invite in shared folder')).toBeInTheDocument();
    });
    expect(mocks.clientMock.parseCalendarEvents).toHaveBeenCalledWith('owner-x', 'blob-1');
    expect(mocks.sourceClientMock.parseCalendarEvents).not.toHaveBeenCalled();
  });

  it('keeps using the active client for unstamped emails', async () => {
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      { uid: 'uid-a', title: 'Invite in account A', start: '2026-03-22T14:00:00Z', participants: {} },
    ]);

    render(<CalendarInvitationBanner email={makeEmail()} />);

    await waitFor(() => {
      expect(screen.getByText('Invite in account A')).toBeInTheDocument();
    });
    expect(mocks.clientMock.parseCalendarEvents).toHaveBeenCalledWith('mail-account', 'blob-1');
    expect(mocks.sourceClientMock.parseCalendarEvents).not.toHaveBeenCalled();
  });

  it('surfaces the underlying error when parsing fails', async () => {
    mocks.clientMock.parseCalendarEvents.mockRejectedValue(new Error('Failed to parse calendar file'));

    render(<CalendarInvitationBanner email={makeEmail()} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to parse calendar file')).toBeInTheDocument();
    });
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
    mocks.calendarState.rsvpEvent.mockResolvedValue(true);

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
    expect(await screen.findByText('Response sent')).toBeInTheDocument();
  });

  it('finds the user under an alias identity the invite was sent to (#1283)', async () => {
    mocks.authState.identities = [{ email: 'user@example.com' }, { email: 'Alias@example.com' }];
    const participants = {
      aliasAttendee: {
        '@type': 'Participant',
        email: 'alias@example.com',
        name: 'User',
        roles: { attendee: true },
        participationStatus: 'needs-action',
      },
    };
    mocks.calendarState.events = [
      { id: 'event-8', uid: 'uid-8', start: '2026-03-30T09:00:00Z', participants },
    ];
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([
      { uid: 'uid-8', title: 'Alias Event', start: '2026-03-30T09:00:00Z', participants },
    ]);
    mocks.calendarState.rsvpEvent.mockResolvedValue(true);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-8' })} />);

    fireEvent.click(await screen.findByText('Accept'));

    await waitFor(() => {
      expect(mocks.calendarState.rsvpEvent).toHaveBeenCalledWith(
        mocks.clientMock,
        'event-8',
        'aliasAttendee',
        'accepted',
        null,
      );
    });
    expect(await screen.findByText('Response sent')).toBeInTheDocument();
  });

  it('says nothing was sent when a plugin stops the answer', async () => {
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
    mocks.calendarState.rsvpEvent.mockResolvedValue(false);

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
    // The plugin that stopped it says why; the banner must not claim it went.
    await waitFor(() => expect(mocks.calendarState.rsvpEvent).toHaveBeenCalled());
    expect(screen.queryByText('Response sent')).not.toBeInTheDocument();
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
    mocks.calendarState.rsvpEvent.mockResolvedValue(true);

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
    mocks.calendarState.updateEvent.mockResolvedValue(true);

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
    mocks.calendarState.updateEvent = vi.fn().mockResolvedValue(true);
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

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-5', from: [{ email: 'alice@example.com' }], attachments: [{ partId: '1', blobId: 'blob-5', size: 256, type: 'text/calendar; method=COUNTER', name: 'counter.ics' }] })} />);

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
    // Another time: the attendees are asked again, as for any move by the
    // organizer; the organizer keeps their answer.
    const [, , patch, send] = mocks.calendarState.updateEvent.mock.calls[0];
    expect(patch).toMatchObject({ start: '2026-03-27T10:00:00Z' });
    expect(patch.participants.organizer.participationStatus).toBe('accepted');
    expect(patch.participants.attendee.participationStatus).toBe('needs-action');
    expect(send).toBe(true);
  });

  // Applying a proposal sends its changes to every attendee. One from an
  // address that is no participant of the meeting (anyone who learned its
  // uid) is shown, but can't be applied.
  it('does not let a proposal from outside the meeting be applied', async () => {
    mocks.calendarState.updateEvent = vi.fn().mockResolvedValue(true);
    const event = (location: string) => ({
      uid: 'uid-12', title: 'Board meeting', start: '2026-03-27T09:00:00Z', duration: 'PT1H',
      virtualLocations: { call: { '@type': 'VirtualLocation', uri: location } },
      participants: {
        organizer: { '@type': 'Participant', email: 'user@example.com', roles: { owner: true }, participationStatus: 'accepted' },
        attendee: { '@type': 'Participant', email: 'alice@example.com', name: 'Alice', roles: { attendee: true }, participationStatus: 'accepted' },
      },
    });
    mocks.calendarState.events = [{ id: 'event-12', ...event('https://meet.example.com/board') }];
    // Names Alice as the attendee proposing, but comes from someone else.
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([event('https://evil.example/board')]);

    render(<CalendarInvitationBanner email={makeEmail({
      id: 'email-12',
      from: [{ email: 'mallory@evil.example' }],
      attachments: [{ partId: '1', blobId: 'blob-12', size: 256, type: 'text/calendar; method=COUNTER', name: 'counter.ics' }],
    })} />);
    await waitFor(() => expect(screen.getByText('Review proposal')).toBeInTheDocument());

    expect(screen.queryByText('Apply proposed changes')).toBeNull();
    expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled();
  });

  it("checks a reply's sender against the attendee who answers, not the organizer", async () => {
    const reply = {
      uid: 'uid-14', title: 'Sync', start: '2026-03-27T09:00:00Z', duration: 'PT1H',
      organizerCalendarAddress: 'mailto:user@example.com',
      participants: {
        a: { '@type': 'Participant', calendarAddress: 'mailto:user@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        b: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
      },
    };
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([reply]);
    const replyFrom = (id: string, from: string) => makeEmail({
      id, from: [{ email: from }],
      attachments: [{ partId: '1', blobId: `blob-${id}`, size: 256, type: 'text/calendar; method=REPLY', name: 'reply.ics' }],
    });

    const { unmount } = render(<CalendarInvitationBanner email={replyFrom('email-14', 'alice@example.com')} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sync' })).toBeInTheDocument());
    expect(screen.queryByText(/was sent from/)).toBeNull();
    unmount();

    render(<CalendarInvitationBanner email={replyFrom('email-15', 'mallory@evil.example')} />);
    await waitFor(() => expect(screen.getByText(
      'This response was sent from mallory@evil.example, while the attendee answering in the calendar data is alice@example.com, and the message could not be verified.',
    )).toBeInTheDocument());
  });

  it('lets a proposal from an attendee Stalwart lists by calendar address be applied', async () => {
    mocks.calendarState.updateEvent = vi.fn().mockResolvedValue(true);
    // As 0.16 and 1.0 store and parse them: mailto: calendar addresses, no email.
    const event = (room: string) => ({
      uid: 'uid-13', title: 'Sync', start: '2026-03-27T09:00:00Z', duration: 'PT1H',
      locations: { room: { '@type': 'Location', name: room } },
      organizerCalendarAddress: 'mailto:user@example.com',
      participants: {
        a: { '@type': 'Participant', calendarAddress: 'mailto:user@example.com', roles: { owner: true }, participationStatus: 'accepted' },
        b: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', participationStatus: 'accepted' },
      },
    });
    mocks.calendarState.events = [{ id: 'event-13', ...event('Room A') }];
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([event('Room B')]);

    render(<CalendarInvitationBanner email={makeEmail({
      id: 'email-13',
      from: [{ email: 'Alice@Example.com' }],
      attachments: [{ partId: '1', blobId: 'blob-13', size: 256, type: 'text/calendar; method=COUNTER', name: 'counter.ics' }],
    })} />);
    await waitFor(() => expect(screen.getByText('Apply proposed changes')).toBeInTheDocument());
  });

  // A proposal for one occurrence of a recurring meeting names it by its
  // recurrence id; it went to the first event with the uid, any occurrence
  // in view.
  describe('a proposal for a recurring meeting', () => {
    const participants = {
      organizer: { '@type': 'Participant', email: 'user@example.com', roles: { owner: true }, participationStatus: 'accepted' },
      attendee: { '@type': 'Participant', email: 'alice@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
    };
    // Two occurrences of a weekly meeting at 09:00 in Berlin, as the server expands them.
    const occurrence = (id: string, day: string) => ({
      id, uid: 'uid-7', title: 'Weekly', start: `2026-03-${day}T09:00:00`, duration: 'PT1H', timeZone: 'Europe/Berlin',
      recurrenceId: `2026-03-${day}T09:00:00`, recurrenceIdTimeZone: 'Europe/Berlin',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }], participants,
    });
    const counter = (extra: Record<string, unknown>) => ({
      uid: 'uid-7', title: 'Weekly', start: '2026-03-27T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', participants, ...extra,
    });
    const openCounter = async (id: string) => {
      render(<CalendarInvitationBanner email={makeEmail({ id, from: [{ email: 'alice@example.com' }], attachments: [{ partId: '1', blobId: `blob-${id}`, size: 256, type: 'text/calendar; method=COUNTER', name: 'counter.ics' }] })} />);
      await waitFor(() => expect(screen.getByText('Review proposal')).toBeInTheDocument());
    };

    beforeEach(() => {
      mocks.calendarState.updateEvent = vi.fn().mockResolvedValue(undefined);
      mocks.calendarState.events = [occurrence('occ-20', '20'), occurrence('occ-27', '27')];
    });

    it('applies a proposal for one occurrence to that occurrence', async () => {
      // Named in UTC: 08:00Z is 09:00 in Berlin in March.
      mocks.clientMock.parseCalendarEvents.mockResolvedValue([counter({ recurrenceId: '2026-03-27T08:00:00', recurrenceIdTimeZone: 'Etc/UTC' })]);

      await openCounter('email-7');
      fireEvent.click(screen.getByText('Apply proposed changes'));
      await waitFor(() => expect(mocks.calendarState.updateEvent).toHaveBeenCalledTimes(1));

      const [, id, patch] = mocks.calendarState.updateEvent.mock.calls[0];
      expect(id).toBe('occ-27');
      expect(patch).toMatchObject({ start: '2026-03-27T10:00:00' });
    });

    it('does not apply a proposal for the whole meeting to one of its occurrences', async () => {
      mocks.clientMock.parseCalendarEvents.mockResolvedValue([counter({})]);

      await openCounter('email-8');

      expect(screen.queryByText('Apply proposed changes')).toBeNull();
      expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled();
    });
  });

  it('keeps the answers when an applied proposal does not change the time', async () => {
    mocks.calendarState.updateEvent = vi.fn().mockResolvedValue(undefined);
    const event = (room: string) => ({
      uid: 'uid-6', title: 'Sync', start: '2026-03-27T09:00:00Z', duration: 'PT1H',
      locations: { room: { '@type': 'Location', name: room } },
      participants: {
        organizer: { '@type': 'Participant', email: 'user@example.com', roles: { owner: true }, participationStatus: 'accepted' },
        attendee: { '@type': 'Participant', email: 'alice@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
      },
    });
    mocks.calendarState.events = [{ id: 'event-6', ...event('Room A') }];
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([event('Room B')]);

    render(<CalendarInvitationBanner email={makeEmail({ id: 'email-6', from: [{ email: 'alice@example.com' }], attachments: [{ partId: '1', blobId: 'blob-6', size: 256, type: 'text/calendar; method=COUNTER', name: 'counter.ics' }] })} />);
    await waitFor(() => expect(screen.getByText('Proposed changes')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Apply proposed changes'));
    await waitFor(() => expect(mocks.calendarState.updateEvent).toHaveBeenCalledTimes(1));

    const [, , patch] = mocks.calendarState.updateEvent.mock.calls[0];
    expect(patch).toEqual({ locations: { room: { '@type': 'Location', name: 'Room B' } } });
  });

  // Stalwart 1.0 refuses an event with more participants than
  // maxParticipantsPerEvent; the banner says so instead of "could not
  // complete".
  describe('when Stalwart 1.0 refuses the participant count', () => {
    const LIMIT = jmapSetError('An event cannot have more than 20 participants.', {
      type: 'invalidProperties', properties: ['participants'],
    });
    const invitation = {
      uid: 'uid-9',
      title: 'All hands',
      start: '2026-03-28T10:00:00Z',
      participants: {
        attendee: {
          '@type': 'Participant', email: 'user@example.com', name: 'User',
          roles: { attendee: true }, participationStatus: 'needs-action',
        },
      },
    };

    it('says so when adding the invitation to the calendar', async () => {
      mocks.calendarState.importEvents.mockRejectedValue(LIMIT);
      mocks.clientMock.parseCalendarEvents.mockResolvedValue([invitation]);
      render(<CalendarInvitationBanner email={makeEmail({ id: 'email-9' })} />);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'All hands' })).toBeInTheDocument());

      fireEvent.click(screen.getByText('Add to calendar'));

      await waitFor(() => {
        expect(screen.getByText('The server allows at most 20 participants per event.')).toBeInTheDocument();
      });
      expect(mocks.calendarState.importEvents).toHaveBeenCalledWith(
        expect.anything(), [expect.objectContaining({ uid: 'uid-9' })], 'cal-1', { throwIfNoneImported: true },
      );
    });

    it('says so when answering an invitation that is not in the calendar yet', async () => {
      mocks.calendarState.importEvents.mockRejectedValue(LIMIT);
      mocks.clientMock.parseCalendarEvents.mockResolvedValue([invitation]);
      render(<CalendarInvitationBanner email={makeEmail({ id: 'email-10' })} />);
      await waitFor(() => expect(screen.getByText('Accept')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Accept'));

      await waitFor(() => {
        expect(screen.getByText('The server allows at most 20 participants per event.')).toBeInTheDocument();
      });
      // Asked to reject: it used to resolve to 0 and say nothing more.
      expect(mocks.calendarState.importEvents).toHaveBeenCalledWith(
        expect.anything(), [expect.objectContaining({ uid: 'uid-9' })], 'cal-1', { throwIfNoneImported: true },
      );
    });

    it('says so when applying a proposal', async () => {
      mocks.calendarState.updateEvent = vi.fn().mockRejectedValue(LIMIT);
      mocks.calendarState.events = [{
        id: 'event-11', uid: 'uid-11', title: 'Sync', start: '2026-03-27T09:00:00Z', duration: 'PT1H',
        participants: {
          organizer: { '@type': 'Participant', email: 'user@example.com', roles: { owner: true }, participationStatus: 'accepted' },
          attendee: { '@type': 'Participant', email: 'alice@example.com', roles: { attendee: true }, participationStatus: 'tentative' },
        },
      }];
      mocks.clientMock.parseCalendarEvents.mockResolvedValue([{
        uid: 'uid-11', title: 'Sync', start: '2026-03-27T10:00:00Z', duration: 'PT1H',
        participants: {
          organizer: { '@type': 'Participant', email: 'user@example.com', roles: { owner: true }, participationStatus: 'accepted' },
          attendee: { '@type': 'Participant', email: 'alice@example.com', roles: { attendee: true }, participationStatus: 'tentative' },
        },
      }]);
      render(<CalendarInvitationBanner email={makeEmail({
        id: 'email-11',
        from: [{ email: 'alice@example.com' }],
        attachments: [{ partId: '1', blobId: 'blob-11', size: 256, type: 'text/calendar; method=COUNTER', name: 'counter.ics' }],
      })} />);
      await waitFor(() => expect(screen.getByText('Apply proposed changes')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Apply proposed changes'));

      await waitFor(() => {
        expect(screen.getByText('The server allows at most 20 participants per event.')).toBeInTheDocument();
      });
    });
  });
});
