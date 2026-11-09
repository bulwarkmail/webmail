import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarInvitationBanner } from '../calendar-invitation-banner';
import type { Email } from '@/lib/jmap/types';

const mocks = vi.hoisted(() => {
  const pushMock = vi.fn();
  const clientMock = {
    parseCalendarEvents: vi.fn(),
    getAccountId: vi.fn(() => 'mail-account'),
    getCalendarsAccountId: vi.fn(() => 'calendar-account'),
    getCalendarEvent: vi.fn(),
    queryCalendarEvents: vi.fn(async (): Promise<unknown[]> => []),
    // Who owns a shared or group account (Principal/get).
    getAccountOwners: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === 'team'
      ? { id, type: 'group', name: 'team@example.com', email: 'team@example.com' }
      : { id, type: 'individual', name: id + '@example.com', email: id + '@example.com' }]))),
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
    deleteEvent: vi.fn(),
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
      answered_accepted: 'You accepted on {date}.',
      answered_declined: 'You declined on {date}.',
      response_declined: 'Declined',
      request_info: 'Respond to let the organizer know.',
      repeats: 'Repeats: {rule}',
      declined_dates: 'You declined {dates}.',
      declined_many: 'You declined {count} meetings of this series.',
      answers_series: 'Your answer is for every meeting in the series.',
      'recurrence.weekly': 'Weekly',
      'recurrence.on_days': 'on {days}',
    };

    let message = strings[key] ?? key;
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        message = message.replace(`{${name}}`, String(value));
      }
    }
    return message;
  },
  useLocale: () => 'en-US',
  useFormatter: () => ({
    dateTime: (date: Date) => date.toISOString(),
  }),
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: mocks.pushMock }),
}));

// The organisation's domains come from the policy and the auth store's state.
vi.mock('@/components/email/external-sender-chip', () => ({ useInternalMailDomains: () => [] }));
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

// pim-p2-8 (and pim-23): a weekly invitation where one week was declined said
// "Your response: Declined. You declined on Wed, Nov 4." while the calendar
// showed the following weeks unanswered, and nothing said it repeats. The
// card now reads the series as stored: its own answer, the declined weeks by
// date, that it repeats, and that the buttons answer every week.

const me = { '@type': 'Participant', email: 'user@example.com', name: 'User', roles: { attendee: true }, participationStatus: 'needs-action' };
const ben = { '@type': 'Participant', email: 'ben@example.com', name: 'Ben', roles: { owner: true, attendee: true }, participationStatus: 'accepted' };
const rule = { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'tu' }] };
const invitation = {
  uid: 'weekly-1', title: 'Weekly sync with Ben', start: '2026-11-03T16:00:00', duration: 'PT30M', timeZone: 'Europe/Berlin',
  recurrenceRules: [rule], participants: { me, ben },
};
// The series as Stalwart 1.0 stores it: Nov 3 declined on its own, as a pointer patch.
const master = {
  id: 'series-1', uid: 'weekly-1', title: 'Weekly sync with Ben', start: '2026-11-03T16:00:00', duration: 'PT30M',
  timeZone: 'Europe/Berlin', recurrenceRules: [rule], participants: { me, ben },
  recurrenceOverrides: { '2026-11-03T16:00:00': { 'participants/me/participationStatus': 'declined' } },
};
// What the grid holds: the expanded occurrences, the declined one first.
const nov3 = {
  ...master, id: 'occ-nov3', recurrenceId: '2026-11-03T16:00:00', recurrenceOverrides: null,
  participants: { me: { ...me, participationStatus: 'declined' }, ben }, updated: '2026-11-04T09:00:00Z',
};
const nov10 = { ...master, id: 'occ-nov10', recurrenceId: '2026-11-10T16:00:00', start: '2026-11-10T16:00:00', recurrenceOverrides: null };

describe('an invitation to a series', () => {
  beforeEach(() => {
    mocks.settingsState.calendarInvitationParsingEnabled = true;
    mocks.clientMock.parseCalendarEvents.mockReset();
    mocks.clientMock.queryCalendarEvents.mockReset();
    mocks.calendarState.rsvpEvent.mockReset();
    mocks.calendarState.events = [nov3, nov10] as never;
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([invitation]);
    mocks.clientMock.queryCalendarEvents.mockImplementation(async () => [master]);
    mocks.authState.identities = [{ email: 'user@example.com' }];
  });

  it("shows the series' own answer and the declined week by its date", async () => {
    render(<CalendarInvitationBanner email={makeEmail()} />);
    expect(await screen.findByText('You declined Nov 3.')).toBeInTheDocument();
    expect(screen.queryByText('Your response: Declined')).not.toBeInTheDocument();
    expect(screen.queryByText(/^You declined on/)).not.toBeInTheDocument();
    expect(screen.getByText('Your response: Needs response')).toBeInTheDocument();
    expect(mocks.clientMock.queryCalendarEvents).toHaveBeenCalledWith({ uid: 'weekly-1' });
  });

  it('says that it repeats, and that an answer is for every week', async () => {
    render(<CalendarInvitationBanner email={makeEmail()} />);
    expect(await screen.findByTestId('invitation-repeats')).toHaveTextContent('Repeats: Weekly on Tue');
    expect(await screen.findByText('Your answer is for every meeting in the series.')).toBeInTheDocument();
  });

  it('answers the series, not the week the calendar held first', async () => {
    mocks.calendarState.rsvpEvent.mockResolvedValue(true);
    render(<CalendarInvitationBanner email={makeEmail()} />);
    await screen.findByText('You declined Nov 3.');
    fireEvent.click(screen.getByText('Accept'));
    await waitFor(() => expect(mocks.calendarState.rsvpEvent).toHaveBeenCalled());
    expect(mocks.calendarState.rsvpEvent.mock.calls[0][1]).toBe('series-1');
    expect(mocks.calendarState.rsvpEvent.mock.calls[0][3]).toBe('accepted');
  });

  it('leaves a one-off invitation as it was', async () => {
    mocks.clientMock.parseCalendarEvents.mockResolvedValue([{ ...invitation, uid: 'once', recurrenceRules: null }]);
    render(<CalendarInvitationBanner email={makeEmail()} />);
    await screen.findByText('Weekly sync with Ben');
    expect(screen.queryByTestId('invitation-repeats')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invitation-answers-series')).not.toBeInTheDocument();
  });
});
