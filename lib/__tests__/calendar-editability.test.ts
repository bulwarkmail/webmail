import { describe, it, expect } from 'vitest';
import type { CalendarEvent, CalendarParticipant, CalendarRights } from '@/lib/jmap/types';
import {
  getEventEditability,
  canCreateEventsIn,
  eventHasNoOwner,
  type EventEditability,
  type EditabilityContext,
} from '@/lib/calendar-editability';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    '@type': 'Event',
    id: 'ev1',
    uid: 'uid-ev1',
    calendarIds: { cal1: true },
    title: 'Test Event',
    description: '',
    descriptionContentType: 'text/plain',
    start: '2026-03-01T10:00:00',
    duration: 'PT1H',
    timeZone: 'UTC',
    showWithoutTime: false,
    status: 'confirmed',
    freeBusyStatus: 'busy',
    privacy: 'public',
    keywords: null,
    categories: null,
    color: null,
    recurrenceId: null,
    recurrenceIdTimeZone: null,
    recurrenceRules: null,
    recurrenceOverrides: null,
    excludedRecurrenceRules: null,
    useDefaultAlerts: false,
    alerts: null,
    locations: null,
    virtualLocations: null,
    links: null,
    relatedTo: null,
    utcStart: null,
    utcEnd: null,
    isDraft: false,
    isOrigin: true,
    sequence: 0,
    created: '2026-03-01T09:00:00Z',
    updated: '2026-03-01T09:00:00Z',
    locale: null,
    replyTo: null,
    organizerCalendarAddress: null,
    participants: null,
    mayInviteSelf: false,
    mayInviteOthers: false,
    hideAttendees: false,
    ...overrides,
  };
}

function makeRights(overrides: Partial<CalendarRights> = {}): CalendarRights {
  return {
    mayReadFreeBusy: false,
    mayReadItems: false,
    mayWriteAll: false,
    mayWriteOwn: false,
    mayUpdatePrivate: false,
    mayRSVP: false,
    mayShare: false,
    mayDelete: false,
    ...overrides,
  };
}

const ALL_RIGHTS = makeRights({
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
});
const READ_ONLY = makeRights({ mayReadFreeBusy: true, mayReadItems: true });
const WRITE_OWN = makeRights({
  mayReadFreeBusy: true, mayReadItems: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true,
});
const RSVP_ONLY = makeRights({
  mayReadFreeBusy: true, mayReadItems: true, mayUpdatePrivate: true, mayRSVP: true,
});

const SELF = 'alice@example.com';
const ALIAS = 'info@example.com';
const OTHER = 'carol@example.com';

const owner = (email: string): Partial<CalendarParticipant> => ({
  '@type': 'Participant', name: email, email, roles: { owner: true, attendee: true },
  sendTo: { imip: `mailto:${email}` }, participationStatus: 'accepted', kind: 'individual',
});
const attendee = (email: string): Partial<CalendarParticipant> => ({
  '@type': 'Participant', name: email, email, roles: { attendee: true },
  sendTo: { imip: `mailto:${email}` }, participationStatus: 'needs-action', kind: 'individual',
});

/** Build a context whose single calendar `cal1` carries the given rights. */
function ctx(
  rights: CalendarRights | null,
  addresses: string[] = [SELF],
  subscriptions: string[] = [],
): EditabilityContext {
  const calendarsById = new Map(rights ? [['cal1', { myRights: rights }]] : []);
  return {
    calendarsById,
    userCalendarAddresses: addresses,
    isSubscriptionCalendar: (id) => subscriptions.includes(id),
  };
}

describe('canCreateEventsIn (issue #762)', () => {
  const sub = (id: string) => id === 'sub';
  it('allows a writable, non-subscription calendar', () => {
    expect(canCreateEventsIn({ id: 'c', myRights: ALL_RIGHTS }, sub)).toBe(true);
    expect(canCreateEventsIn({ id: 'c', myRights: WRITE_OWN }, sub)).toBe(true);
  });
  it('rejects a read-only calendar', () => {
    expect(canCreateEventsIn({ id: 'c', myRights: READ_ONLY }, sub)).toBe(false);
    expect(canCreateEventsIn({ id: 'c', myRights: RSVP_ONLY }, sub)).toBe(false);
  });
  it('rejects an iCal subscription even when its Stalwart rights are writable', () => {
    expect(canCreateEventsIn({ id: 'sub', myRights: ALL_RIGHTS }, sub)).toBe(false);
  });
  it('is permissive when myRights is absent (local/birthday calendars)', () => {
    expect(canCreateEventsIn({ id: 'c', myRights: undefined as never }, sub)).toBe(true);
  });
});

describe('eventHasNoOwner', () => {
  it('is true for a plain event with no participants/organizer', () => {
    expect(eventHasNoOwner(makeEvent())).toBe(true);
  });
  it('is false when an owner-role participant exists', () => {
    expect(eventHasNoOwner(makeEvent({ participants: { a: owner(SELF) } as never }))).toBe(false);
  });
  it('is false when an event-level organizer address exists', () => {
    expect(eventHasNoOwner(makeEvent({ organizerCalendarAddress: `mailto:${OTHER}` }))).toBe(false);
  });
  it('is false when a reply destination exists', () => {
    expect(eventHasNoOwner(makeEvent({ replyTo: { imip: `mailto:${OTHER}` } }))).toBe(false);
  });
  it('is true when only non-owner participants exist', () => {
    expect(eventHasNoOwner(makeEvent({ participants: { b: attendee(OTHER) } as never }))).toBe(true);
  });
});

describe('getEventEditability - calendar rights gate', () => {
  it('mayWriteAll -> editable even when the user is not the organizer', () => {
    const ev = makeEvent({ isOrigin: false, organizerCalendarAddress: `mailto:${OTHER}`,
      participants: { a: owner(OTHER), b: attendee(SELF) } as never });
    expect(getEventEditability(ev, ctx(ALL_RIGHTS))).toBe('editable');
  });

  it('read-only calendar -> read-only even for an event the user organizes', () => {
    const ev = makeEvent({ organizerCalendarAddress: `mailto:${SELF}`,
      participants: { a: owner(SELF) } as never });
    expect(getEventEditability(ev, ctx(READ_ONLY))).toBe('read-only');
  });

  it('mayWriteOwn + user is organizer -> editable', () => {
    const ev = makeEvent({ participants: { a: owner(SELF), b: attendee(OTHER) } as never });
    expect(getEventEditability(ev, ctx(WRITE_OWN))).toBe('editable');
  });

  it('mayWriteOwn + user is a mere attendee -> rsvp-only (cannot edit body)', () => {
    const ev = makeEvent({ isOrigin: false, organizerCalendarAddress: `mailto:${OTHER}`,
      participants: { a: owner(OTHER), b: attendee(SELF) } as never });
    expect(getEventEditability(ev, ctx(WRITE_OWN))).toBe('rsvp-only');
  });

  it('mayWriteOwn + ownerless event -> editable', () => {
    const ev = makeEvent({ participants: { b: attendee(SELF) } as never });
    expect(getEventEditability(ev, ctx(WRITE_OWN))).toBe('editable');
  });

  it('RSVP-only rights + participant -> rsvp-only', () => {
    const ev = makeEvent({ isOrigin: false, organizerCalendarAddress: `mailto:${OTHER}`,
      participants: { a: owner(OTHER), b: attendee(SELF) } as never });
    expect(getEventEditability(ev, ctx(RSVP_ONLY))).toBe('rsvp-only');
  });

  it('RSVP-only rights + user is NOT a participant -> read-only', () => {
    const ev = makeEvent({ isOrigin: false, organizerCalendarAddress: `mailto:${OTHER}`,
      participants: { a: owner(OTHER), b: attendee('dave@example.com') } as never });
    expect(getEventEditability(ev, ctx(RSVP_ONLY))).toBe('read-only');
  });

  it('no write / no rsvp rights -> read-only', () => {
    const ev = makeEvent({ participants: { a: owner(SELF) } as never });
    expect(getEventEditability(ev, ctx(READ_ONLY))).toBe('read-only');
  });
});

describe('getEventEditability - subscription calendars', () => {
  it('an event in a client-side iCal subscription is read-only regardless of rights/organizer', () => {
    const ev = makeEvent({ organizerCalendarAddress: `mailto:${SELF}`,
      participants: { a: owner(SELF) } as never });
    // Even if the (irrelevant) rights map says all-writable, the subscription wins.
    expect(getEventEditability(ev, ctx(ALL_RIGHTS, [SELF], ['cal1']))).toBe('read-only');
  });
});

describe('getEventEditability - unknown calendar rights', () => {
  it('own origin copy is editable when rights are not yet loaded', () => {
    expect(getEventEditability(makeEvent({ isOrigin: true }), ctx(null))).toBe('editable');
  });
  it('a delivered (non-origin) copy stays read-only until rights load', () => {
    expect(getEventEditability(makeEvent({ isOrigin: false }), ctx(null))).toBe('read-only');
  });
});

describe('getEventEditability - alias over-permissiveness regression', () => {
  it('organizer == account alias in a READ-ONLY shared calendar -> read-only (not editable)', () => {
    // The alias branch would have matched isOrganizer and opened the editor; the
    // rights gate must keep it read-only.
    const ev = makeEvent({ isOrigin: false, organizerCalendarAddress: `mailto:${ALIAS}`,
      participants: { a: owner(ALIAS) } as never });
    expect(getEventEditability(ev, ctx(READ_ONLY, [SELF, ALIAS]))).toBe('read-only');
  });

  it('organizer == account alias in a WRITE-OWN calendar -> editable (legitimate alias edit)', () => {
    const ev = makeEvent({ organizerCalendarAddress: `mailto:${ALIAS}`,
      participants: { a: owner(ALIAS) } as never });
    expect(getEventEditability(ev, ctx(WRITE_OWN, [SELF, ALIAS]))).toBe('editable');
  });
});

describe('getEventEditability - multi-calendar membership', () => {
  it('requires the right on EVERY calendar (a read-only member blocks edit)', () => {
    const ev = makeEvent({ calendarIds: { cal1: true, cal2: true },
      participants: { a: owner(SELF) } as never });
    const context: EditabilityContext = {
      calendarsById: new Map([
        ['cal1', { myRights: ALL_RIGHTS }],
        ['cal2', { myRights: READ_ONLY }],
      ]),
      userCalendarAddresses: [SELF],
      isSubscriptionCalendar: () => false,
    };
    expect(getEventEditability(ev, context)).toBe('read-only');
  });
});

describe('getEventEditability - matrix sanity', () => {
  const cases: Array<[string, CalendarRights, boolean, EventEditability]> = [
    ['writeAll/organizer', ALL_RIGHTS, true, 'editable'],
    ['writeAll/attendee', ALL_RIGHTS, false, 'editable'],
    ['writeOwn/organizer', WRITE_OWN, true, 'editable'],
    ['writeOwn/attendee', WRITE_OWN, false, 'rsvp-only'],
    ['rsvpOnly/attendee', RSVP_ONLY, false, 'rsvp-only'],
    ['readOnly/organizer', READ_ONLY, true, 'read-only'],
    ['readOnly/attendee', READ_ONLY, false, 'read-only'],
  ];
  it.each(cases)('%s -> %s', (_label, rights, userIsOrganizer, expected) => {
    const ev = userIsOrganizer
      ? makeEvent({ participants: { a: owner(SELF), b: attendee(OTHER) } as never })
      : makeEvent({ isOrigin: false, organizerCalendarAddress: `mailto:${OTHER}`,
          participants: { a: owner(OTHER), b: attendee(SELF) } as never });
    expect(getEventEditability(ev, ctx(rights))).toBe(expected);
  });
});
