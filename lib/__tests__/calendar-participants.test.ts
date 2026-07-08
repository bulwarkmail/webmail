import { describe, it, expect } from 'vitest';
import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import {
  isOrganizer,
  getUserParticipantId,
  getUserStatus,
  getParticipantList,
  getStatusCounts,
  getParticipantCount,
  buildParticipantMap,
} from '@/lib/calendar-participants';

function makeEvent(participants: Record<string, Partial<CalendarParticipant>> | null = null): CalendarEvent {
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
  };
}

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
    });
    expect(list.find(p => p.id === 'att1')).toEqual({
      id: 'att1',
      name: 'Bob',
      email: 'bob@example.com',
      status: 'needs-action',
      isOrganizer: false,
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
    expect(counts.accepted).toBe(2);
    expect(counts.declined).toBe(1);
    expect(counts.tentative).toBe(1);
    expect(counts['needs-action']).toBe(1);
  });

  it('returns all zeros when no participants', () => {
    const event = makeEvent(null);
    const counts = getStatusCounts(event);
    expect(counts).toEqual({ accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 });
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
    expect(org!.roles).toEqual({ owner: true, attendee: true });
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
    expect(org.roles).toEqual({ owner: true, attendee: true });
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

  it('sets kind to individual for all entries', () => {
    const map = buildParticipantMap(
      { name: 'Alice', email: 'alice@example.com' },
      [{ name: 'Bob', email: 'bob@example.com' }]
    );
    Object.values(map).forEach(p => {
      expect(p.kind).toBe('individual');
    });
  });
});
