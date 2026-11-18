import { describe, it, expect } from 'vitest';
import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import {
  isOrganizer,
  collectUserCalendarAddresses,
  getUserParticipantId,
  getUserStatus,
  isDeclinedByUser,
  getParticipantList,
  getStatusCounts,
  getParticipantCount,
  buildParticipantMap,
  participantFieldsToSave,
  participantLimitOf,
  participantsAskedAgain,
  hasAnsweredAttendees,
  movedEventUpdates,
  userOrganizes,
} from '@/lib/calendar-participants';
import { jmapError, jmapSetError } from '@/lib/jmap/jmap-error';

function makeEvent(
  participants: Record<string, Partial<CalendarParticipant>> | null = null,
  overrides: Partial<CalendarEvent> = {}
): CalendarEvent {
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
    participants: participants as Record<string, CalendarParticipant> | null,
    mayInviteSelf: false,
    mayInviteOthers: false,
    hideAttendees: false,
    ...overrides,
  };
}

// What Stalwart hands back after an iCalendar round-trip: the ORGANIZER line is
// rebuilt as a participant carrying only calendarAddress — no roles, no status.
const stalwartOrganizerParticipant: Partial<CalendarParticipant> = {
  '@type': 'Participant',
  calendarAddress: 'mailto:alice@example.com',
};

const orgParticipant: Partial<CalendarParticipant> = {
  '@type': 'Participant',
  name: 'Alice',
  email: 'alice@example.com',
  roles: { owner: true, attendee: true },
  participationStatus: 'accepted',
  scheduleAgent: 'server',
  sendTo: { imip: 'mailto:alice@example.com' },
  expectReply: false,
  kind: 'individual',
};

const attendeeParticipant: Partial<CalendarParticipant> = {
  '@type': 'Participant',
  name: 'Bob',
  email: 'bob@example.com',
  roles: { attendee: true },
  participationStatus: 'needs-action',
  scheduleAgent: 'server',
  sendTo: { imip: 'mailto:bob@example.com' },
  expectReply: true,
  kind: 'individual',
};

const acceptedAttendee: Partial<CalendarParticipant> = {
  ...attendeeParticipant,
  name: 'Carol',
  email: 'carol@example.com',
  participationStatus: 'accepted',
};

const declinedAttendee: Partial<CalendarParticipant> = {
  ...attendeeParticipant,
  name: 'Dave',
  email: 'dave@example.com',
  participationStatus: 'declined',
};

const tentativeAttendee: Partial<CalendarParticipant> = {
  ...attendeeParticipant,
  name: 'Eve',
  email: 'eve@example.com',
  participationStatus: 'tentative',
};

describe('isOrganizer', () => {
  it('returns true when user email matches organizer', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(isOrganizer(event, ['alice@example.com'])).toBe(true);
  });

  it('returns true with case-insensitive match', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(isOrganizer(event, ['ALICE@EXAMPLE.COM'])).toBe(true);
  });

  it('returns false when user is not organizer', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(isOrganizer(event, ['bob@example.com'])).toBe(false);
  });

  it('returns false when no participants', () => {
    const event = makeEvent(null);
    expect(isOrganizer(event, ['alice@example.com'])).toBe(false);
  });

  it('returns true when user has multiple emails and one matches', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(isOrganizer(event, ['other@example.com', 'alice@example.com'])).toBe(true);
  });

  it('returns false when empty user emails', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(isOrganizer(event, [])).toBe(false);
  });

  it('matches the event-level organizerCalendarAddress when no owner role is set', () => {
    // Stalwart / imported self-organized events: the user's participant only
    // carries `attendee`, the organizer lives in organizerCalendarAddress.
    const event = makeEvent({
      self: {
        '@type': 'Participant',
        name: 'Alice',
        email: '',
        roles: { attendee: true },
        participationStatus: 'accepted',
        sendTo: { imip: 'mailto:alice@example.com' },
        kind: 'individual',
      },
    });
    event.organizerCalendarAddress = 'mailto:alice@example.com';
    expect(isOrganizer(event, ['alice@example.com'])).toBe(true);
  });

  it('matches the event-level organizerCalendarAddress case-insensitively', () => {
    const event = makeEvent({ att1: attendeeParticipant });
    event.organizerCalendarAddress = 'mailto:Alice@Example.com';
    expect(isOrganizer(event, ['alice@example.com'])).toBe(true);
  });

  it('falls back to replyTo when organizerCalendarAddress is absent', () => {
    const event = makeEvent({ att1: attendeeParticipant });
    event.replyTo = { imip: 'mailto:alice@example.com' };
    expect(isOrganizer(event, ['alice@example.com'])).toBe(true);
  });

  it('returns false when the event organizer is someone else', () => {
    const event = makeEvent({ att1: attendeeParticipant });
    event.organizerCalendarAddress = 'mailto:someoneelse@example.com';
    expect(isOrganizer(event, ['alice@example.com'])).toBe(false);
  });

  // Regression: an event organized under one of the account's ALIAS addresses
  // is still the user's own event and must be recognised as such (otherwise the
  // calendar UI flips it to a read-only invite). The primary address alone does
  // not match; the alias has to be part of the user's address list.
  it('does NOT match an alias organizer when only the primary address is known', () => {
    const event = makeEvent({ att1: attendeeParticipant });
    event.organizerCalendarAddress = 'mailto:info@example.com'; // an account alias
    expect(isOrganizer(event, ['alice@example.com'])).toBe(false);
  });

  it('matches an alias organizer once the alias is included in the address list', () => {
    const event = makeEvent({ att1: attendeeParticipant });
    event.organizerCalendarAddress = 'mailto:info@example.com';
    const addresses = collectUserCalendarAddresses(['alice@example.com'], ['info@example.com']);
    expect(isOrganizer(event, addresses)).toBe(true);
  });

  it('matches an alias owner participant once the alias is included', () => {
    const event = makeEvent({
      org: { ...orgParticipant, email: 'info@example.com', sendTo: { imip: 'mailto:info@example.com' } },
    });
    const addresses = collectUserCalendarAddresses(['alice@example.com'], ['INFO@example.com']);
    expect(isOrganizer(event, addresses)).toBe(true);
  });
});

describe('collectUserCalendarAddresses', () => {
  it('merges identity and alias addresses', () => {
    expect(collectUserCalendarAddresses(['alice@example.com'], ['info@example.com', 'sales@example.com']))
      .toEqual(['alice@example.com', 'info@example.com', 'sales@example.com']);
  });

  it('de-duplicates case-insensitively, keeping the first-seen casing', () => {
    expect(collectUserCalendarAddresses(['Alice@Example.com'], ['alice@example.com', 'INFO@example.com']))
      .toEqual(['Alice@Example.com', 'INFO@example.com']);
  });

  it('drops empty, undefined and whitespace-only entries', () => {
    expect(collectUserCalendarAddresses(['alice@example.com', '', '  ', undefined, null], []))
      .toEqual(['alice@example.com']);
  });

  it('trims surrounding whitespace', () => {
    expect(collectUserCalendarAddresses(['  alice@example.com  '], [])).toEqual(['alice@example.com']);
  });

  it('returns an empty array when given no addresses', () => {
    expect(collectUserCalendarAddresses([], [])).toEqual([]);
  });
});

describe('getUserParticipantId', () => {
  it('returns the participant ID for the user', () => {
    const event = makeEvent({
      org: orgParticipant,
      att1: attendeeParticipant,
    });
    expect(getUserParticipantId(event, ['bob@example.com'])).toBe('att1');
  });

  it('returns organizer ID when user is organizer', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(getUserParticipantId(event, ['alice@example.com'])).toBe('org');
  });

  it('returns null when user not found', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(getUserParticipantId(event, ['unknown@example.com'])).toBeNull();
  });

  it('returns null when no participants', () => {
    const event = makeEvent(null);
    expect(getUserParticipantId(event, ['alice@example.com'])).toBeNull();
  });

  it('matches case-insensitively', () => {
    const event = makeEvent({ att1: attendeeParticipant });
    expect(getUserParticipantId(event, ['BOB@EXAMPLE.COM'])).toBe('att1');
  });
});

describe('getUserStatus', () => {
  it('returns the participation status', () => {
    const event = makeEvent({ att1: attendeeParticipant });
    expect(getUserStatus(event, ['bob@example.com'])).toBe('needs-action');
  });

  it('returns accepted for organizer', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(getUserStatus(event, ['alice@example.com'])).toBe('accepted');
  });

  it('returns null when user not found', () => {
    const event = makeEvent({ org: orgParticipant });
    expect(getUserStatus(event, ['unknown@example.com'])).toBeNull();
  });

  it('returns null when no participants', () => {
    const event = makeEvent(null);
    expect(getUserStatus(event, ['alice@example.com'])).toBeNull();
  });
});

describe('isDeclinedByUser', () => {
  it("is true only for the user's own declined entry", () => {
    const event = makeEvent({ att1: attendeeParticipant, dave: declinedAttendee });
    expect(isDeclinedByUser(event, ['Dave@Example.com'])).toBe(true);
    expect(isDeclinedByUser(event, ['bob@example.com'])).toBe(false);
  });

  it('matches the calendar address an occurrence override carries', () => {
    // A reply to one occurrence comes back from Stalwart as an override
    // participant with only a calendarAddress (#1110).
    const event = makeEvent({
      att: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', participationStatus: 'declined' },
    });
    expect(isDeclinedByUser(event, ['alias@example.com', 'bob@example.com'])).toBe(true);
  });

  it('is false without user addresses or participants', () => {
    expect(isDeclinedByUser(makeEvent({ dave: declinedAttendee }), [])).toBe(false);
    expect(isDeclinedByUser(makeEvent({ dave: declinedAttendee }), undefined)).toBe(false);
    expect(isDeclinedByUser(makeEvent(null), ['dave@example.com'])).toBe(false);
  });
});

describe('getParticipantList', () => {
  it('returns all participants as info objects', () => {
    const event = makeEvent({
      org: orgParticipant,
      att1: attendeeParticipant,
    });
    const list = getParticipantList(event);
    expect(list).toHaveLength(2);
    expect(list.find(p => p.id === 'org')).toEqual({
      id: 'org',
      name: 'Alice',
      email: 'alice@example.com',
      status: 'accepted',
      isOrganizer: true,
      optional: false,
    });
    expect(list.find(p => p.id === 'att1')).toEqual({
      id: 'att1',
      name: 'Bob',
      email: 'bob@example.com',
      status: 'needs-action',
      isOrganizer: false,
      optional: false,
    });
  });

  it('returns empty array when no participants', () => {
    const event = makeEvent(null);
    expect(getParticipantList(event)).toEqual([]);
  });

  it('defaults status to needs-action for missing status', () => {
    const event = makeEvent({
      att1: { ...attendeeParticipant, participationStatus: undefined },
    });
    const list = getParticipantList(event);
    expect(list[0].status).toBe('needs-action');
  });

  // #731: without this the organizer is treated as a plain attendee, seeded
  // into the invite list on reopen, and re-saved as a duplicate every time.
  it('flags the roles-less organizer Stalwart derives from ORGANIZER', () => {
    const event = makeEvent(
      { org: stalwartOrganizerParticipant, att1: attendeeParticipant },
      { organizerCalendarAddress: 'mailto:alice@example.com' }
    );
    const list = getParticipantList(event);
    expect(list.find(p => p.id === 'org')).toMatchObject({
      email: 'alice@example.com',
      isOrganizer: true,
    });
    expect(list.find(p => p.id === 'att1')!.isOrganizer).toBe(false);
  });

  it('matches the organizer address case-insensitively', () => {
    const event = makeEvent(
      { org: { '@type': 'Participant', calendarAddress: 'mailto:Alice@Example.COM' } },
      { organizerCalendarAddress: 'mailto:alice@example.com' }
    );
    expect(getParticipantList(event)[0].isOrganizer).toBe(true);
  });

  it('flags the organizer via the legacy replyTo address', () => {
    const event = makeEvent(
      { org: stalwartOrganizerParticipant },
      { replyTo: { imip: 'mailto:alice@example.com' } }
    );
    expect(getParticipantList(event)[0].isOrganizer).toBe(true);
  });

  // #738: the organizer arrives twice — once as the participant our client
  // wrote (owner role, accepted) and once as an ATTENDEE line the server's
  // scheduling added — so every list showed a phantom fourth participant
  // still "awaiting" a reply.
  it('renders the organizer once when the server also emits them as an attendee', () => {
    const event = makeEvent(
      {
        org: { ...orgParticipant, name: '' },
        att1: attendeeParticipant,
        att2: { ...attendeeParticipant, name: 'Carol', email: 'carol@example.com' },
        orgDup: { ...attendeeParticipant, name: '', email: 'alice@example.com', sendTo: { imip: 'mailto:alice@example.com' } },
      },
      { organizerCalendarAddress: 'mailto:alice@example.com' }
    );
    const list = getParticipantList(event);
    expect(list).toHaveLength(3);
    const alices = list.filter(p => p.email === 'alice@example.com');
    expect(alices).toHaveLength(1);
    expect(alices[0]).toMatchObject({ isOrganizer: true, status: 'accepted' });
  });

  it('keeps the real RSVP when the duplicate is the needs-action entry', () => {
    // Reverse insertion order: the spurious attendee entry comes first with
    // no reply, the owner entry (accepted) second.
    const event = makeEvent(
      {
        att1: { ...attendeeParticipant, name: '', email: 'alice@example.com' },
        org: orgParticipant,
      },
      { organizerCalendarAddress: 'mailto:alice@example.com' }
    );
    const list = getParticipantList(event);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ isOrganizer: true, status: 'accepted', name: 'Alice' });
  });

  it('deduplicates plain attendees regardless of insertion order', () => {
    const event = makeEvent({
      att1: { ...attendeeParticipant, name: 'Bob' },
      att2: { ...attendeeParticipant, name: 'Bobby', participationStatus: 'accepted' },
      att3: { ...attendeeParticipant, name: 'Carol', email: 'carol@example.com' },
    });
    const list = getParticipantList(event);
    expect(list).toHaveLength(2);
    const bobs = list.filter(p => p.email === 'bob@example.com');
    expect(bobs).toHaveLength(1);
    expect(bobs[0].status).toBe('accepted');
    expect(bobs[0].name).toBe('Bob'); // first-seen name wins
  });

  it('merges duplicate addresses case-insensitively', () => {
    const event = makeEvent({
      org: { ...orgParticipant, email: 'Alice@Example.com' },
      orgDup: { ...attendeeParticipant, name: '', email: 'alice@example.com' },
    });
    expect(getParticipantList(event)).toHaveLength(1);
  });

  // The organizer owes no reply to their own invitation; the statusless
  // participant Stalwart derives from ORGANIZER must not read as "pending".
  it('shows the statusless organizer as accepted', () => {
    const event = makeEvent(
      { org: stalwartOrganizerParticipant },
      { organizerCalendarAddress: 'mailto:alice@example.com' }
    );
    const list = getParticipantList(event);
    expect(list[0].isOrganizer).toBe(true);
    expect(list[0].status).toBe('accepted');
  });

  it('fills missing names from the resolveName option without overriding event data', () => {
    const event = makeEvent({
      org: { ...orgParticipant, name: '' },
      att1: attendeeParticipant,
    });
    const resolveName = (email: string) =>
      email === 'alice@example.com' ? '爱丽丝' : undefined;
    const list = getParticipantList(event, { resolveName });
    expect(list.find(p => p.email === 'alice@example.com')!.name).toBe('爱丽丝');
    // Bob has a name in the event; the resolver must not clobber it (it
    // returns undefined for him anyway, but the contract is "fill, not replace").
    expect(list.find(p => p.email === 'bob@example.com')!.name).toBe('Bob');
  });

  it('keeps entries without an address unmerged', () => {
    const event = makeEvent({
      org: orgParticipant,
      ghost1: { '@type': 'Participant', name: 'No Address', participationStatus: 'needs-action' },
      ghost2: { '@type': 'Participant', name: 'Also No Address', participationStatus: 'accepted' },
    });
    const list = getParticipantList(event);
    expect(list).toHaveLength(3);
  });
});

describe('getStatusCounts', () => {
  it('counts statuses correctly', () => {
    const event = makeEvent({
      org: orgParticipant,
      att1: acceptedAttendee,
      att2: declinedAttendee,
      att3: tentativeAttendee,
      att4: attendeeParticipant,
    });
    const counts = getStatusCounts(event);
    // The organizer is excluded: they are not awaiting their own reply.
    expect(counts.accepted).toBe(1);
    expect(counts.declined).toBe(1);
    expect(counts.tentative).toBe(1);
    expect(counts['needs-action']).toBe(1);
  });

  it('returns all zeros when no participants', () => {
    const event = makeEvent(null);
    const counts = getStatusCounts(event);
    expect(counts).toEqual({ accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 });
  });

  // #731: the statusless participant Stalwart rebuilds from ORGANIZER would
  // otherwise show the organizer as one more attendee still owing a response.
  it('does not count the roles-less organizer as pending', () => {
    const event = makeEvent(
      { org: stalwartOrganizerParticipant, att1: attendeeParticipant },
      { organizerCalendarAddress: 'mailto:alice@example.com' }
    );
    const counts = getStatusCounts(event);
    expect(counts['needs-action']).toBe(1);
    expect(counts.accepted).toBe(0);
  });
});

describe('getParticipantCount', () => {
  it('returns correct count', () => {
    const event = makeEvent({
      org: orgParticipant,
      att1: attendeeParticipant,
    });
    expect(getParticipantCount(event)).toBe(2);
  });

  it('returns 0 when no participants', () => {
    const event = makeEvent(null);
    expect(getParticipantCount(event)).toBe(0);
  });

  // #738: the participant badge on event cards counted raw entries, so an
  // organizer the server emits twice showed "4 participants" for three people.
  it('counts addresses, not raw entries', () => {
    const event = makeEvent({
      org: { ...orgParticipant, name: '' },
      att1: attendeeParticipant,
      att2: { ...attendeeParticipant, name: 'Carol', email: 'carol@example.com' },
      orgDup: { ...attendeeParticipant, name: '', email: 'alice@example.com' },
    });
    expect(getParticipantCount(event)).toBe(3);
  });

  it('counts address-less entries individually', () => {
    const event = makeEvent({
      org: orgParticipant,
      ghost: { '@type': 'Participant', name: 'No Address' },
    });
    expect(getParticipantCount(event)).toBe(2);
  });
});

describe('buildParticipantMap', () => {
  it('creates organizer and attendees', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [
        { name: 'Bob', email: 'bob@example.com' },
        { name: 'Carol', email: 'carol@example.com' },
      ]
    );

    expect(Object.keys(map)).toHaveLength(3);

    // Entries are keyed by generated UUIDs (RFC 8984 participant ids), so
    // look them up by identity rather than by a fixed key.
    const entries = Object.values(map);

    const org = entries.find(p => p.roles?.owner);
    expect(org).toBeDefined();
    expect(org!.name).toBe('Alice');
    expect(org!.email).toBe('alice@example.com');
    expect(org!.roles).toEqual({ owner: true });
    expect(org!.participationStatus).toBe('accepted');
    expect(org!.scheduleAgent).toBe('server');
    // sendTo is retired in draft-ietf-calext-jscalendarbis; the scheduling
    // address is carried by calendarAddress instead.
    expect(org!.sendTo).toBeUndefined();
    expect(org!.calendarAddress).toBe('mailto:alice@example.com');
    expect(org!.expectReply).toBe(false);

    const att0 = entries.find(p => p.email === 'bob@example.com');
    expect(att0).toBeDefined();
    expect(att0!.name).toBe('Bob');
    expect(att0!.roles).toEqual({ attendee: true });
    expect(att0!.participationStatus).toBe('needs-action');
    expect(att0!.scheduleAgent).toBe('server');
    expect(att0!.expectReply).toBe(true);

    const att1 = entries.find(p => p.email === 'carol@example.com');
    expect(att1).toBeDefined();
    expect(att1!.name).toBe('Carol');
  });

  it('creates only organizer when no attendees', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      []
    );
    expect(Object.keys(map)).toHaveLength(1);
    const org = Object.values(map)[0];
    expect(org).toBeDefined();
    expect(org.roles).toEqual({ owner: true });
  });

  it('sets @type to Participant for all entries', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [{ name: 'Bob', email: 'bob@example.com' }]
    );
    Object.values(map).forEach(p => {
      expect(p['@type']).toBe('Participant');
    });
  });

  it('omits blank names rather than sending an empty one', () => {
    const map = buildParticipantMap(
      { name: '', email: 'alice@example.com' },
      [
        { name: '   ', email: 'bob@example.com' },
        { name: '  Carol  ', email: 'carol@example.com' },
      ]
    );
    const entries = Object.values(map);

    // An empty name becomes a bare `CN=` downstream, which renders as a dangling
    // "- Organizer" and as guests listed with nothing before their address.
    expect(entries.find(p => p.email === 'alice@example.com')).not.toHaveProperty('name');
    expect(entries.find(p => p.email === 'bob@example.com')).not.toHaveProperty('name');
    expect(entries.find(p => p.email === 'carol@example.com')!.name).toBe('Carol');
  });

  it('sets kind to individual for all entries', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [{ name: 'Bob', email: 'bob@example.com' }]
    );
    Object.values(map).forEach(p => {
      expect(p.kind).toBe('individual');
    });
  });

  // #731: the organizer must never also be written as an attendee, however
  // they reached the invite list.
  it('drops the organizer from the attendee list', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [
        { name: 'Alice', email: 'alice@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ]
    );
    expect(Object.keys(map)).toHaveLength(2);
    expect(Object.values(map).filter(p => p.roles?.attendee)).toHaveLength(1);
    const alice = Object.values(map).filter(p => p.email === 'alice@example.com');
    expect(alice).toHaveLength(1);
    expect(alice[0].roles).toEqual({ owner: true });
  });

  it('drops the organizer regardless of case or surrounding whitespace', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [{ name: '', email: '  ALICE@Example.com  ' }]
    );
    expect(Object.keys(map)).toHaveLength(1);
    expect(Object.values(map)[0].roles).toEqual({ owner: true });
  });

  it('deduplicates repeated attendee addresses case-insensitively', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [
        { name: 'Bob', email: 'bob@example.com' },
        { name: 'Bobby', email: 'BOB@example.com' },
        { name: 'Carol', email: 'carol@example.com' },
      ]
    );
    expect(Object.keys(map)).toHaveLength(3);
    const bobs = Object.values(map).filter(p => p.email?.toLowerCase() === 'bob@example.com');
    expect(bobs).toHaveLength(1);
    expect(bobs[0].name).toBe('Bob');
  });

  it('skips blank attendee addresses', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [{ name: 'Nobody', email: '   ' }, { name: 'Bob', email: 'bob@example.com' }]
    );
    expect(Object.keys(map)).toHaveLength(2);
    expect(Object.values(map).some(p => p.name === 'Nobody')).toBe(false);
  });

  it('keeps the id and answer of an address the event already lists, whatever its case', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [{ name: 'Bob', email: 'bob@example.com' }, { name: 'Carol', email: 'carol@example.com' }],
      {
        org: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com' },
        b1: { '@type': 'Participant', calendarAddress: 'mailto:BOB@Example.com', participationStatus: 'declined' },
      } as unknown as Record<string, CalendarParticipant>,
    );

    // The organizer, listed without an answer, stays accepted.
    expect(map.org).toMatchObject({ calendarAddress: 'mailto:alice@example.com', participationStatus: 'accepted' });
    expect(map.b1).toMatchObject({ email: 'bob@example.com', participationStatus: 'declined' });
    const carol = Object.entries(map).find(([, p]) => p.email === 'carol@example.com')!;
    expect(['org', 'b1']).not.toContain(carol[0]);
    expect(carol[1].participationStatus).toBe('needs-action');
  });

  it('takes the real answer of an address listed twice', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [{ name: 'Bob', email: 'bob@example.com' }],
      {
        first: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', participationStatus: 'needs-action' },
        second: { '@type': 'Participant', email: 'bob@example.com', participationStatus: 'tentative' },
      } as unknown as Record<string, CalendarParticipant>,
    );
    expect(map.first.participationStatus).toBe('tentative');
    expect(map).not.toHaveProperty('second');
  });
});

// The editor rewrote the organizer on every save of an event with attendees:
// participants rebuilt around the user's first address, organizerCalendarAddress
// set to it, and every attendee back to needs-action. On an invitation that
// made the user its organizer; on a series organized under another address or
// letter case it gave one occurrence another owner (Stalwart 1.0 refuses the
// organizerCalendarAddress there: "This property cannot be modified on a
// single occurrence."), and every save dropped the answers.
describe('participantFieldsToSave', () => {
  const me = { userEmail: 'me@example.com', resolveName: (email: string) => (email === 'me@example.com' ? 'Me Myself' : undefined) };
  const rows = (...emails: string[]) => emails.map((email) => ({ name: '', email }));

  it('keeps the sender of an invitation as its organizer and everyone\'s answer', () => {
    const invitation = makeEvent({
      boss: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.org' },
      mine: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
      bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.org', roles: { attendee: true }, participationStatus: 'declined' },
    }, { organizerCalendarAddress: 'mailto:boss@example.org' });

    const fields = participantFieldsToSave(invitation, rows('me@example.com', 'bob@example.org'), me);

    expect(fields).not.toHaveProperty('organizerCalendarAddress');
    expect(Object.keys(fields.participants!).sort()).toEqual(['bob', 'boss', 'mine']);
    expect(fields.participants!.boss).toMatchObject({ calendarAddress: 'mailto:boss@example.org', roles: { owner: true } });
    expect(fields.participants!.mine.participationStatus).toBe('accepted');
    expect(fields.participants!.bob.participationStatus).toBe('declined');
  });

  it('keeps the address a series is organized under, letter case included (Stalwart 1.0 checks it on one occurrence)', () => {
    const series = makeEvent({
      org: { '@type': 'Participant', calendarAddress: 'mailto:ME@Example.com', roles: { owner: true }, participationStatus: 'accepted' },
      guest: { '@type': 'Participant', calendarAddress: 'mailto:guest@example.net', roles: { attendee: true }, participationStatus: 'accepted' },
    }, { organizerCalendarAddress: 'mailto:ME@Example.com' });

    const fields = participantFieldsToSave(series, rows('guest@example.net'), me);

    expect(fields).not.toHaveProperty('organizerCalendarAddress');
    expect(fields.participants!.org).toMatchObject({ calendarAddress: 'mailto:ME@Example.com', roles: { owner: true } });
    expect(fields.participants!.guest.participationStatus).toBe('accepted');
  });

  it('takes the organizer from organizerCalendarAddress when no participant is marked as one', () => {
    const event = makeEvent({
      guest: { '@type': 'Participant', calendarAddress: 'mailto:guest@example.net', roles: { attendee: true } },
    }, { organizerCalendarAddress: 'mailto:alias@example.com' });

    const fields = participantFieldsToSave(event, rows('guest@example.net'), me);

    const organizer = Object.values(fields.participants!).find((p) => p.roles?.owner);
    expect(organizer?.calendarAddress).toBe('mailto:alias@example.com');
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('makes the user the organizer of an event that has none', () => {
    for (const event of [null, makeEvent(null)]) {
      const fields = participantFieldsToSave(event, rows('guest@example.net'), me);

      expect(fields.organizerCalendarAddress).toBe('mailto:me@example.com');
      const organizer = Object.values(fields.participants!).find((p) => p.roles?.owner);
      expect(organizer).toMatchObject({ name: 'Me Myself', calendarAddress: 'mailto:me@example.com', participationStatus: 'accepted' });
    }
  });

  it('removes the participants, the organizer and replyTo with the last attendee', () => {
    const event = makeEvent({
      org: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { owner: true } },
      guest: { '@type': 'Participant', calendarAddress: 'mailto:guest@example.net', roles: { attendee: true } },
    }, { organizerCalendarAddress: 'mailto:me@example.com', replyTo: { imip: 'mailto:me@example.com' } });

    expect(participantFieldsToSave(event, [], me)).toEqual({ participants: null, organizerCalendarAddress: null, replyTo: null });
    expect(participantFieldsToSave(makeEvent(null), [], me)).toEqual({});
  });
});

// RFC 5546: an organizer who moves an event asks the attendees again, and
// Stalwart's update to them carries each attendee's stored answer (it adds
// needs-action only where there is none). So when the user, as organizer,
// changes when an event happens, the other attendees go back to
// needs-action; every other save keeps the answers.
describe.each<['0.16' | '1.0']>([['0.16'], ['1.0']])('participantFieldsToSave for a moved event on Stalwart %s', (version) => {
  // As each version stores them: 0.16.23 drops an attendee's roles, 1.0 keeps them.
  const attendee = (address: string, participationStatus: CalendarParticipant['participationStatus']) => ({
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address, participationStatus,
    ...(version === '1.0' ? { roles: { attendee: true } } : {}),
  }) as Partial<CalendarParticipant>;
  const organizer = (address: string) => ({
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address, roles: { owner: true }, participationStatus: 'accepted',
  }) as Partial<CalendarParticipant>;
  const rows = (...emails: string[]) => emails.map((email) => ({ name: '', email }));
  const me = { userEmail: 'me@example.com', userEmails: ['me@example.com', 'me-alias@example.com'] };

  // Organized under the user's alias, in another letter case.
  const own = () => makeEvent({
    org: organizer('Me-Alias@Example.com'),
    bob: attendee('bob@example.org', 'accepted'),
    carol: attendee('carol@example.org', 'declined'),
  }, { organizerCalendarAddress: 'mailto:Me-Alias@Example.com' });

  it('asks the other attendees again when the user organizes it', () => {
    const fields = participantFieldsToSave(own(), rows('bob@example.org', 'carol@example.org'), { ...me, rescheduled: true });

    expect(fields.participants!.org).toMatchObject({ calendarAddress: 'mailto:Me-Alias@Example.com', participationStatus: 'accepted' });
    expect(fields.participants!.bob.participationStatus).toBe('needs-action');
    expect(fields.participants!.carol.participationStatus).toBe('needs-action');
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('keeps the answers when the event is not moved', () => {
    const fields = participantFieldsToSave(own(), rows('bob@example.org', 'carol@example.org'), { ...me, rescheduled: false });

    expect(fields.participants!.bob.participationStatus).toBe('accepted');
    expect(fields.participants!.carol.participationStatus).toBe('declined');
  });

  it('never asks again for an event someone else organizes', () => {
    // The user's copy of an invitation: not the organizer's (isOrigin).
    const invitation = makeEvent({
      boss: organizer('boss@example.org'),
      mine: attendee('me@example.com', 'accepted'),
      bob: attendee('bob@example.org', 'declined'),
    }, { organizerCalendarAddress: 'mailto:boss@example.org', isOrigin: false });

    const fields = participantFieldsToSave(invitation, rows('me@example.com', 'bob@example.org'), { ...me, rescheduled: true });

    expect(fields.participants!.mine.participationStatus).toBe('accepted');
    expect(fields.participants!.bob.participationStatus).toBe('declined');
  });

  // userc shares a calendar with the user (read & write): userc's meeting in
  // it is the organizer's copy, and a move there goes out from userc. The
  // user attends it too, and 0.16 sends the user nothing of their own change
  // (their address counts as the account's own): reset, their answer stayed
  // needs-action in userc's copy (live on 0.16.23).
  it('asks the others again, not the user, when the user moves the owner\'s meeting in a calendar shared with them', () => {
    const shared = makeEvent({
      owner: organizer('userc@example.org'),
      anna: attendee('usera@example.org', 'accepted'),
      mine: attendee('me@example.com', 'tentative'),
    }, { organizerCalendarAddress: 'mailto:userc@example.org', isOrigin: true, isShared: true, accountId: 'f' });

    const fields = participantFieldsToSave(shared, rows('usera@example.org', 'me@example.com'), { ...me, rescheduled: true });

    expect(fields.participants!.owner).toMatchObject({ calendarAddress: 'mailto:userc@example.org', participationStatus: 'accepted' });
    expect(fields.participants!.anna.participationStatus).toBe('needs-action');
    expect(fields.participants!.mine.participationStatus).toBe('tentative');
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('keeps the answer of an address the user attends under, whichever of theirs it is', () => {
    const shared = makeEvent({
      owner: organizer('userc@example.org'),
      mine: attendee('ME-ALIAS@example.com', 'declined'),
    }, { organizerCalendarAddress: 'mailto:userc@example.org', isOrigin: true, isShared: true, accountId: 'f' });

    const fields = participantFieldsToSave(shared, rows('me-alias@example.com'), { ...me, rescheduled: true });

    expect(fields.participants!.mine.participationStatus).toBe('declined');
  });
});

// What Stalwart sends: a new event, and an occurrence that gets its own
// override, reach only attendees without an answer (PARTSTAT absent or
// NEEDS-ACTION); a change to an existing one reaches everyone who has not
// declined, with the answer stored for them.
describe.each<['0.16' | '1.0']>([['0.16'], ['1.0']])('asking the attendees again on Stalwart %s', (version) => {
  // As each version stores them: 0.16.23 drops an attendee's roles, 1.0 keeps them.
  const attendee = (address: string, participationStatus?: CalendarParticipant['participationStatus']) => ({
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address,
    ...(participationStatus ? { participationStatus } : {}),
    ...(version === '1.0' ? { roles: { attendee: true } } : {}),
  }) as Partial<CalendarParticipant>;
  const meeting = () => makeEvent({
    org: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
    // The organizer listed as an attendee as well, as Google writes it.
    orgAgain: attendee('ME@example.com', 'accepted'),
    bob: attendee('bob@example.org', 'accepted'),
    carol: attendee('carol@example.org', 'declined'),
    dave: attendee('dave@example.org'),
  }, { organizerCalendarAddress: 'mailto:me@example.com' });

  it('puts every attendee back to needs-action and leaves the organizer as it is', () => {
    const asked = participantsAskedAgain(meeting())!;

    expect(asked.org.participationStatus).toBe('accepted');
    expect(asked.orgAgain.participationStatus).toBe('accepted');
    expect(asked.bob).toEqual({ ...meeting().participants!.bob, participationStatus: 'needs-action' });
    expect(asked.carol.participationStatus).toBe('needs-action');
    expect(asked.dave).toEqual(meeting().participants!.dave);
  });

  it('changes nothing when no attendee has answered', () => {
    expect(participantsAskedAgain(makeEvent({
      org: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
      dave: attendee('dave@example.org', 'needs-action'),
    }, { organizerCalendarAddress: 'mailto:me@example.com' }))).toBeNull();
    expect(participantsAskedAgain(makeEvent(null))).toBeNull();
  });

  it('tells whether an attendee answered and did not decline', () => {
    expect(hasAnsweredAttendees(meeting())).toBe(true);
    const { bob: _bob, ...withoutBob } = meeting().participants!;
    expect(hasAnsweredAttendees({ ...meeting(), participants: withoutBob })).toBe(false);
    expect(hasAnsweredAttendees(makeEvent(null))).toBe(false);
  });
});

// A drag or a resize saved the way the editor saves a move: the organizer
// asks the attendees again and tells them; anyone else moves their own copy
// quietly. Live on 1.0 and 0.16.23 a dragged event stayed "accepted" for
// the new time, and a dragged occurrence reached no one who had answered.
describe.each<['0.16' | '1.0']>([['0.16'], ['1.0']])('movedEventUpdates on Stalwart %s', (version) => {
  const attendee = (address: string, participationStatus: CalendarParticipant['participationStatus']) => ({
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address, participationStatus,
    ...(version === '1.0' ? { roles: { attendee: true } } : {}),
  }) as Partial<CalendarParticipant>;
  // isOrigin as the server says it: whether the organizer is an address of
  // the account the event is in.
  const meeting = (organizer: string, extra: Partial<CalendarEvent> = {}) => makeEvent({
    org: { '@type': 'Participant', calendarAddress: `mailto:${organizer}`, roles: { owner: true }, participationStatus: 'accepted' },
    bob: attendee('bob@example.org', 'accepted'),
    me: attendee('me@example.com', 'tentative'),
  }, { organizerCalendarAddress: `mailto:${organizer}`, isOrigin: organizer.toLowerCase() === 'me@example.com', ...extra });
  const MOVE = { start: '2026-03-01T11:00:00' };

  it('asks the attendees again and tells them when the user organizes the event', () => {
    const { updates, sendSchedulingMessages } = movedEventUpdates(meeting('ME@example.com'), MOVE, ['me@example.com']);

    expect(sendSchedulingMessages).toBe(true);
    expect(updates.start).toBe(MOVE.start);
    expect(updates.participants!.org.participationStatus).toBe('accepted');
    expect(updates.participants!.bob.participationStatus).toBe('needs-action');
  });

  it('moves someone else\'s event quietly, answers as they are', () => {
    expect(movedEventUpdates(meeting('boss@example.org'), MOVE, ['me@example.com']))
      .toEqual({ updates: MOVE, sendSchedulingMessages: undefined });
  });

  // userc's meeting in userc's calendar, shared with the user read & write:
  // Stalwart sends the move from userc. It went out to nobody, and the
  // attendees kept the old time (live on 1.0 and 0.16.23). The user, who
  // attends too, keeps their answer: 0.16 sends them nothing of their own
  // move, and reset, it stayed needs-action in userc's copy (live on 0.16.23).
  it('asks the other attendees again and tells them when the user moves the owner\'s meeting in a shared calendar', () => {
    const { updates, sendSchedulingMessages } = movedEventUpdates(
      meeting('userc@example.org', { isOrigin: true, isShared: true, accountId: 'f' }), MOVE, ['me@example.com'],
    );

    expect(sendSchedulingMessages).toBe(true);
    expect(updates.participants!.org.participationStatus).toBe('accepted');
    expect(updates.participants!.bob.participationStatus).toBe('needs-action');
    expect(updates.participants!.me.participationStatus).toBe('tentative');
  });

  it('moves the owner\'s copy of someone else\'s meeting in a shared calendar quietly', () => {
    expect(movedEventUpdates(meeting('boss@example.org', { isShared: true, accountId: 'f' }), MOVE, ['me@example.com']))
      .toEqual({ updates: MOVE, sendSchedulingMessages: undefined });
  });

  it('moves an event without participants quietly', () => {
    expect(movedEventUpdates(makeEvent(null), MOVE, ['me@example.com'])).toEqual({ updates: MOVE, sendSchedulingMessages: undefined });
    expect(movedEventUpdates(undefined, MOVE, ['me@example.com'])).toEqual({ updates: MOVE, sendSchedulingMessages: undefined });
  });

  it('tells, and changes no answer, when nobody has answered yet', () => {
    const fresh = makeEvent({
      org: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
      bob: attendee('bob@example.org', 'needs-action'),
    }, { organizerCalendarAddress: 'mailto:me@example.com' });

    expect(movedEventUpdates(fresh, MOVE, ['me@example.com'])).toEqual({ updates: MOVE, sendSchedulingMessages: true });
  });
});

describe('userOrganizes', () => {
  it('is the user under any of their addresses, or anyone for an event without an organizer', () => {
    const own = makeEvent({ org: { '@type': 'Participant', calendarAddress: 'mailto:Alias@Example.com', roles: { owner: true } } }, { isOrigin: false });
    expect(userOrganizes(own, ['me@example.com', 'alias@example.com'])).toBe(true);
    expect(userOrganizes(own, ['me@example.com'])).toBe(false);
    expect(userOrganizes(makeEvent({ bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.org' } }, { isOrigin: false }), ['me@example.com'])).toBe(true);
  });

  // What userb sees in userc's calendar, shared read & write, as each version
  // returns it (live): isOrigin is true where userc organizes, false for an
  // invitation userc got, for the event and for each expanded occurrence.
  describe.each<['0.16' | '1.0']>([['0.16'], ['1.0']])('in a calendar shared with the user on Stalwart %s', (version) => {
    const inShared = (organizer: string, isOrigin: boolean) => makeEvent({
      org: { '@type': 'Participant', calendarAddress: `mailto:${organizer}`, roles: { owner: true }, participationStatus: 'accepted' },
      b: {
        '@type': 'Participant', calendarAddress: 'mailto:userb@example.org', participationStatus: 'accepted',
        ...(version === '1.0' ? { roles: { attendee: true } } : {}),
      },
    }, { organizerCalendarAddress: `mailto:${organizer}`, isOrigin, isShared: true, accountId: 'f' });

    it('is the owner\'s meeting: the server schedules it from the owner', () => {
      expect(userOrganizes(inShared('userc@example.org', true), ['userb@example.org'])).toBe(true);
    });

    it('is not an invitation the owner got', () => {
      expect(userOrganizes(inShared('usera@example.org', false), ['userb@example.org'])).toBe(false);
    });
  });
});

describe('participantLimitOf', () => {
  it('reads the limit from Stalwart 1.0’s refusal', () => {
    const refusal = jmapSetError('An event cannot have more than 20 participants.', {
      type: 'invalidProperties', properties: ['participants'],
    });
    expect(participantLimitOf(refusal)).toBe(20);
  });

  it('is null for any other failure', () => {
    expect(participantLimitOf(jmapSetError('Invalid property or value.', { type: 'invalidProperties', properties: ['participants'] }))).toBeNull();
    expect(participantLimitOf(jmapError('An event cannot have more than 20 participants.', { type: 'forbidden' }))).toBeNull();
    expect(participantLimitOf(new Error('An event cannot have more than 20 participants.'))).toBeNull();
    expect(participantLimitOf(undefined)).toBeNull();
  });
});
