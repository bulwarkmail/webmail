import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  findCalendarAttachment,
  getInvitationActorSummary,
  getInvitationMethod,
  getInvitationTrustAssessment,
  formatEventSummary,
  formatInvitationSchedule,
  findParticipantByEmail,
} from '../calendar-invitation';
import type { Email, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';

// As the reader opens a message: the full fetch has found its results written on receipt.
function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: {},
    size: 1024,
    receivedAt: '2026-02-17T10:00:00Z',
    hasAttachment: false,
    authenticationResultsOnReceipt: true,
    ...overrides,
  };
}

function makeParticipant(overrides: Partial<CalendarParticipant> = {}): CalendarParticipant {
  return {
    '@type': 'Participant',
    name: 'Test',
    email: 'test@example.com',
    calendarAddress: null,
    description: null,
    sendTo: null,
    kind: 'individual',
    roles: { attendee: true },
    participationStatus: 'needs-action',
    participationComment: null,
    expectReply: false,
    scheduleAgent: 'server',
    scheduleForceSend: false,
    scheduleId: null,
    scheduleSequence: 0,
    scheduleStatus: null,
    scheduleUpdated: null,
    invitedBy: null,
    delegatedTo: null,
    delegatedFrom: null,
    memberOf: null,
    locationId: null,
    language: null,
    links: null,
    ...overrides,
  };
}

describe('findCalendarAttachment', () => {
  it('finds attachment by MIME type text/calendar', () => {
    const email = makeEmail({
      attachments: [
        { partId: '1', blobId: 'b1', size: 500, type: 'text/calendar', name: 'invite.ics' },
      ],
      hasAttachment: true,
    });
    const result = findCalendarAttachment(email);
    expect(result).toBeTruthy();
    expect(result!.blobId).toBe('b1');
  });

  it('finds attachment by application/ics type', () => {
    const email = makeEmail({
      attachments: [
        { partId: '1', blobId: 'b2', size: 500, type: 'application/ics', name: 'event.ics' },
      ],
      hasAttachment: true,
    });
    expect(findCalendarAttachment(email)?.blobId).toBe('b2');
  });

  it('finds attachment by .ics file extension', () => {
    const email = makeEmail({
      attachments: [
        { partId: '1', blobId: 'b3', size: 500, type: 'application/octet-stream', name: 'meeting.ics' },
      ],
      hasAttachment: true,
    });
    expect(findCalendarAttachment(email)?.blobId).toBe('b3');
  });

  it('finds attachment by .ical file extension', () => {
    const email = makeEmail({
      attachments: [
        { partId: '1', blobId: 'b4', size: 500, type: 'application/octet-stream', name: 'meeting.ical' },
      ],
      hasAttachment: true,
    });
    expect(findCalendarAttachment(email)?.blobId).toBe('b4');
  });

  it('returns null when no calendar attachment exists', () => {
    const email = makeEmail({
      attachments: [
        { partId: '1', blobId: 'b5', size: 500, type: 'application/pdf', name: 'doc.pdf' },
      ],
      hasAttachment: true,
    });
    expect(findCalendarAttachment(email)).toBeNull();
  });

  it('returns null when attachments is undefined', () => {
    const email = makeEmail();
    expect(findCalendarAttachment(email)).toBeNull();
  });

  it('finds attachment when text/calendar includes MIME parameters', () => {
    const email = makeEmail({
      attachments: [
        { partId: '1', blobId: 'b6', size: 500, type: 'text/calendar; method=REQUEST; charset=UTF-8' },
      ],
      hasAttachment: true,
    });
    expect(findCalendarAttachment(email)?.blobId).toBe('b6');
  });

  it('detects text/calendar in textBody parts', () => {
    const email = makeEmail({
      textBody: [
        { partId: 'p1', blobId: 'tb1', size: 300, type: 'text/calendar' },
      ],
    });
    const result = findCalendarAttachment(email);
    expect(result).toBeTruthy();
    expect(result!.blobId).toBe('tb1');
  });

  it('detects nested text/calendar body parts inside multipart structures', () => {
    const email = makeEmail({
      textBody: [
        {
          partId: 'root',
          blobId: 'rootBlob',
          size: 100,
          type: 'multipart/alternative',
          subParts: [
            { partId: 'plain', blobId: 'plainBlob', size: 50, type: 'text/plain' },
            { partId: 'ical', blobId: 'tbNested', size: 300, type: 'text/calendar; method=REQUEST; charset=UTF-8' },
          ],
        },
      ],
    });
    expect(findCalendarAttachment(email)?.blobId).toBe('tbNested');
  });

  it('prioritizes attachments over textBody', () => {
    const email = makeEmail({
      attachments: [
        { partId: '1', blobId: 'att1', size: 500, type: 'text/calendar', name: 'invite.ics' },
      ],
      textBody: [
        { partId: 'p1', blobId: 'tb1', size: 300, type: 'text/calendar' },
      ],
      hasAttachment: true,
    });
    expect(findCalendarAttachment(email)?.blobId).toBe('att1');
  });
});

describe('getInvitationMethod', () => {
  it('detects cancel when status is cancelled', () => {
    expect(getInvitationMethod({ status: 'cancelled' })).toBe('cancel');
  });

  it('detects request from MIME Content-Type method parameter', () => {
    const event: Partial<CalendarEvent> = {};
    const email = makeEmail({
      headers: {
        'Content-Type': 'text/calendar; method=REQUEST; charset=UTF-8',
      },
    });
    expect(getInvitationMethod(event, { email })).toBe('request');
  });

  it('detects reply from attachment MIME method parameter', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        att: makeParticipant({ participationStatus: 'accepted' }),
      },
    };
    expect(getInvitationMethod(event, {
      attachment: { type: 'text/calendar; method=REPLY; charset=UTF-8' },
    })).toBe('reply');
  });

  it('detects publish, add, refresh, counter, and declinecounter from MIME parameters', () => {
    const event: Partial<CalendarEvent> = {};
    expect(getInvitationMethod(event, { attachment: { type: 'text/calendar; method=PUBLISH' } })).toBe('publish');
    expect(getInvitationMethod(event, { attachment: { type: 'text/calendar; method=ADD' } })).toBe('add');
    expect(getInvitationMethod(event, { attachment: { type: 'text/calendar; method=REFRESH' } })).toBe('refresh');
    expect(getInvitationMethod(event, { attachment: { type: 'text/calendar; method=COUNTER' } })).toBe('counter');
    expect(getInvitationMethod(event, { attachment: { type: 'text/calendar; method=DECLINECOUNTER' } })).toBe('declinecounter');
  });

  it('does not treat text/calendar without method as iMIP metadata', () => {
    const event: Partial<CalendarEvent> = {};
    const email = makeEmail({
      headers: {
        'Content-Type': 'text/calendar; charset=UTF-8',
      },
    });
    expect(getInvitationMethod(event, { email })).toBe('unknown');
  });

  it('detects request when participants have organizer role', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, name: 'Organizer' }),
        att: makeParticipant({ roles: { attendee: true }, name: 'Attendee' }),
      },
    };
    expect(getInvitationMethod(event)).toBe('request');
  });

  it('detects request with chair role', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { chair: true }, name: 'Chair' }),
      },
    };
    expect(getInvitationMethod(event)).toBe('request');
  });

  it('returns unknown when no participants', () => {
    expect(getInvitationMethod({})).toBe('unknown');
  });

  it('returns unknown when participants have no organizer', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        att: makeParticipant({ roles: { attendee: true } }),
      },
    };
    expect(getInvitationMethod(event)).toBe('unknown');
  });

  it('infers reply when attendee status is present without an organizer', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        att: makeParticipant({ roles: { attendee: true }, participationStatus: 'accepted' }),
      },
    };
    expect(getInvitationMethod(event)).toBe('reply');
  });
});

describe('getInvitationActorSummary', () => {
  it('picks the attendee as actor for reply-like methods', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com', name: 'Organizer' }),
        att: makeParticipant({
          roles: { attendee: true },
          email: 'alice@example.com',
          name: 'Alice',
          participationStatus: 'accepted',
          participationComment: 'Works for me',
        }),
      },
    };

    expect(getInvitationActorSummary(event, 'reply')).toMatchObject({
      role: 'attendee',
      name: 'Alice',
      participationStatus: 'accepted',
      participationComment: 'Works for me',
    });
  });

  it('picks the organizer as actor for declinecounter', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com', name: 'Organizer' }),
        att: makeParticipant({
          roles: { attendee: true },
          email: 'alice@example.com',
          name: 'Alice',
          participationStatus: 'tentative',
        }),
      },
    };

    expect(getInvitationActorSummary(event, 'declinecounter')).toMatchObject({
      role: 'organizer',
      name: 'Organizer',
      email: 'organizer@example.com',
    });
  });
});

describe('formatEventSummary', () => {
  it('extracts title from event', () => {
    const summary = formatEventSummary({ title: 'Team Sync' });
    expect(summary.title).toBe('Team Sync');
  });

  it('extracts location from event', () => {
    const summary = formatEventSummary({
      locations: { loc1: { '@type': 'Location', name: 'Room A', description: null, locationTypes: null, coordinates: null, timeZone: null, links: null, relativeTo: null } },
    });
    expect(summary.location).toBe('Room A');
  });

  it('extracts organizer info', () => {
    const summary = formatEventSummary({
      participants: {
        org: makeParticipant({ roles: { owner: true }, name: 'Alice', email: 'alice@example.com' }),
        att: makeParticipant({ roles: { attendee: true }, name: 'Bob' }),
      },
    });
    expect(summary.organizer).toBe('Alice');
    expect(summary.organizerEmail).toBe('alice@example.com');
    expect(summary.attendeeCount).toBe(1);
  });

  it('handles missing data gracefully', () => {
    const summary = formatEventSummary({});
    expect(summary.title).toBe('');
    expect(summary.start).toBeNull();
    expect(summary.end).toBeNull();
    expect(summary.location).toBeNull();
    expect(summary.organizer).toBeNull();
    expect(summary.attendeeCount).toBe(0);
  });

  it('computes end from start + duration', () => {
    const summary = formatEventSummary({
      start: '2026-02-17T10:00:00',
      duration: 'PT1H30M',
    });
    expect(summary.start).toBe('2026-02-17T10:00:00');
    expect(summary.end).toBe('2026-02-17T11:30:00');
  });

  it('uses utcStart and utcEnd when available', () => {
    const summary = formatEventSummary({
      utcStart: '2026-02-17T15:00:00Z',
      utcEnd: '2026-02-17T16:00:00Z',
      start: '2026-02-17T10:00:00',
      duration: 'PT1H',
    });
    expect(summary.start).toBe('2026-02-17T15:00:00Z');
    expect(summary.end).toBe('2026-02-17T16:00:00Z');
    expect(summary.isAllDay).toBe(false);
  });

  it('prefers local start over utcStart for all-day events', () => {
    const summary = formatEventSummary({
      utcStart: '2026-03-16T00:00:00Z',
      utcEnd: '2026-03-17T00:00:00Z',
      start: '2026-03-16T00:00:00',
      showWithoutTime: true,
    });
    expect(summary.start).toBe('2026-03-16T00:00:00');
    expect(summary.end).toBe('2026-03-17T00:00:00');
    expect(summary.isAllDay).toBe(true);
  });

  it('computes all-day end in local format when utcEnd is missing', () => {
    const summary = formatEventSummary({
      start: '2026-03-16T00:00:00',
      duration: 'P1D',
      showWithoutTime: true,
    });
    expect(summary.start).toBe('2026-03-16T00:00:00');
    expect(summary.end).toBe('2026-03-17T00:00:00');
    expect(summary.isAllDay).toBe(true);
  });

  it('infers all-day summaries from midnight-to-midnight events without the flag', () => {
    const summary = formatEventSummary({
      start: '2026-03-16T00:00:00',
      duration: 'PT24H',
    });
    expect(summary.start).toBe('2026-03-16T00:00:00');
    expect(summary.end).toBe('2026-03-17T00:00:00');
    expect(summary.isAllDay).toBe(true);
  });

  it('returns local format end for timed events with local start', () => {
    const summary = formatEventSummary({
      start: '2026-02-17T10:00:00',
      duration: 'PT1H30M',
    });
    expect(summary.end).toBe('2026-02-17T11:30:00');
  });
});

describe('getInvitationTrustAssessment', () => {
  it('warns when mail authentication fails', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com' }),
      },
    };

    const result = getInvitationTrustAssessment(event, makeEmail({
      from: [{ email: 'organizer@example.com' }],
      authenticationResults: {
        dmarc: { result: 'fail', domain: 'example.com', policy: 'reject' },
      },
    }), 'request');

    expect(result.level).toBe('warning');
    expect(result.reason).toBe('authentication_failed');
  });

  it('trusts an invitation a relay broke SPF for when DKIM and DMARC still pass (#1403)', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'alice@example.com' }),
      },
    };
    const from = [{ email: 'alice@example.com' }];

    const relayed = getInvitationTrustAssessment(event, makeEmail({
      from,
      authenticationResults: {
        spf: { result: 'fail', domain: 'example.com' },
        dkim: { result: 'pass', domain: 'example.com' },
        dmarc: { result: 'pass', domain: 'example.com' },
      },
    }), 'request');
    expect(relayed.level).toBe('trusted');

    const unsigned = getInvitationTrustAssessment(event, makeEmail({
      from,
      authenticationResults: { spf: { result: 'fail', domain: 'example.com' } },
    }), 'request');
    expect(unsigned.reason).toBe('authentication_failed');
  });

  it('warns when sender and organizer differ without verified authentication', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com' }),
      },
    };

    const result = getInvitationTrustAssessment(event, makeEmail({
      from: [{ email: 'calendar-bot@example.net' }],
    }), 'request');

    expect(result.level).toBe('warning');
    expect(result.reason).toBe('sender_mismatch_unverified');
  });

  it('shows caution when sender and organizer differ but authentication passed', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com' }),
      },
    };

    const result = getInvitationTrustAssessment(event, makeEmail({
      from: [{ email: 'assistant@example.com' }],
      authenticationResults: {
        dkim: { result: 'pass', domain: 'example.com', selector: 'mail' },
      },
    }), 'request');

    expect(result.level).toBe('caution');
    expect(result.reason).toBe('sender_mismatch');
  });

  it('shows caution when an invitation has no verified authentication', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com' }),
      },
    };

    const result = getInvitationTrustAssessment(event, makeEmail({
      from: [{ email: 'organizer@example.com' }],
    }), 'request');

    expect(result.level).toBe('caution');
    expect(result.reason).toBe('authentication_missing');
  });

  it('returns trusted when sender matches organizer and authentication passed', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com' }),
      },
    };

    const result = getInvitationTrustAssessment(event, makeEmail({
      from: [{ email: 'organizer@example.com' }],
      authenticationResults: {
        spf: { result: 'pass', domain: 'example.com', ip: '203.0.113.5' },
      },
    }), 'request');

    expect(result.level).toBe('trusted');
    expect(result.reason).toBeNull();
  });

  // A reply comes from the attendee, and the organizer is the user reading
  // it: comparing with the organizer warned on every genuine reply, and a
  // forged one looked just the same.
  it.each(['reply', 'counter', 'refresh'] as const)('compares the sender of a %s with the attendee who answers', (method) => {
    const event: Partial<CalendarEvent> = {
      participants: {
        // As Stalwart parses it: the organizer is an attendee too, addresses as mailto:.
        org: makeParticipant({ roles: { owner: true, attendee: true }, email: undefined, calendarAddress: 'mailto:me@example.com', participationStatus: 'accepted' }),
        bob: makeParticipant({ roles: { attendee: true }, email: undefined, calendarAddress: 'mailto:Bob@example.net', participationStatus: 'accepted' }),
      },
    };
    const aligned = { dkim: { result: 'pass', domain: 'example.net', selector: 's' } } as const;

    const genuine = getInvitationTrustAssessment(event, makeEmail({ from: [{ email: 'bob@example.net' }], authenticationResults: aligned }), method);
    expect(genuine.level).toBe('trusted');

    const forged = getInvitationTrustAssessment(event, makeEmail({ from: [{ email: 'mallory@evil.example' }] }), method);
    expect(forged).toMatchObject({
      level: 'warning', reason: 'attendee_mismatch_unverified', senderEmail: 'mallory@evil.example', attendeeEmail: 'bob@example.net',
    });
  });

  it('does not trust an SPF or DKIM pass for a domain other than the From domain', () => {
    // MAIL FROM at the attacker's domain (SPF pass there), From and ORGANIZER
    // at the victim's; the victim publishes no DMARC policy, so dmarc=none.
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'organizer@example.com' }),
      },
    };
    const email = (authenticationResults: NonNullable<ReturnType<typeof makeEmail>['authenticationResults']>) =>
      makeEmail({ from: [{ email: 'organizer@example.com' }], authenticationResults });

    const spf = getInvitationTrustAssessment(event, email({
      spf: { result: 'pass', domain: 'attacker.example', ip: '203.0.113.5' },
      dmarc: { result: 'none', domain: 'example.com' },
    }), 'request');
    expect(spf.level).toBe('caution');
    expect(spf.reason).toBe('authentication_missing');

    const dkim = getInvitationTrustAssessment(event, email({
      dkim: { result: 'pass', domain: 'attacker.example', selector: 's1' },
      dmarc: { result: 'none', domain: 'example.com' },
    }), 'request');
    expect(dkim.level).toBe('caution');
    expect(dkim.reason).toBe('authentication_missing');
  });

  // Mail a signed-in user hands in never passes port 25, so Stalwart adds no
  // Authentication-Results header to it (#1374).
  describe('mail between users of the reader\'s own domains', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'alice@example.com' }),
      },
    };
    const own = ['bob@example.com', 'Bob@Example.org'];

    it('trusts an invitation without an Authentication-Results header', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({ from: [{ email: 'alice@example.com' }] }), 'request', own);
      expect(result.level).toBe('trusted');
    });

    it('still cautions when the sender is on another domain', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({ from: [{ email: 'alice@example.com' }] }), 'request', ['bob@example.net']);
      expect(result.reason).toBe('authentication_missing');
    });

    it('still cautions when the header is there but nothing in it passed', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({
        from: [{ email: 'alice@example.com' }],
        authenticationResults: { dmarc: { result: 'none', domain: 'example.com' } },
      }), 'request', own);
      expect(result.reason).toBe('authentication_missing');
    });

    it('still warns when the sender is not the organizer', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({ from: [{ email: 'carol@example.com' }] }), 'request', own);
      expect(result.reason).toBe('sender_mismatch_unverified');
    });
  });

  // One server, several domains: the admin lists them as internal (#1593).
  describe('mail from another of the organisation\'s domains', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        org: makeParticipant({ roles: { owner: true }, email: 'alice@a.example' }),
      },
    };
    const own = ['bob@b.example'];
    const from = [{ email: 'alice@a.example' }];

    it('cautions while the domain is not listed', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({ from }), 'request', own);
      expect(result.reason).toBe('authentication_missing');
    });

    it('trusts an invitation without an Authentication-Results header from a listed domain', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({ from }), 'request', own, ['b.example', 'a.example']);
      expect(result.level).toBe('trusted');
    });

    it('counts a subdomain of a listed domain, as the External chip does', () => {
      const sub: Partial<CalendarEvent> = { participants: { org: makeParticipant({ roles: { owner: true }, email: 'alice@eu.a.example' }) } };
      const result = getInvitationTrustAssessment(sub, makeEmail({ from: [{ email: 'alice@eu.a.example' }] }), 'request', own, ['a.example']);
      expect(result.level).toBe('trusted');
      const lookalike: Partial<CalendarEvent> = { participants: { org: makeParticipant({ roles: { owner: true }, email: 'alice@nota.example' }) } };
      expect(getInvitationTrustAssessment(lookalike, makeEmail({ from: [{ email: 'alice@nota.example' }] }), 'request', own, ['a.example']).reason)
        .toBe('authentication_missing');
    });

    it('still checks a listed domain whose mail came in from outside', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({
        from,
        authenticationResults: { dmarc: { result: 'none', domain: 'a.example' } },
      }), 'request', own, ['a.example']);
      expect(result.reason).toBe('authentication_missing');
      const failed = getInvitationTrustAssessment(event, makeEmail({
        from,
        authenticationResults: { dmarc: { result: 'fail', domain: 'a.example' } },
      }), 'request', own, ['a.example']);
      expect(failed.reason).toBe('authentication_failed');
    });

    it('still warns when the sender is not the organizer', () => {
      const result = getInvitationTrustAssessment(event, makeEmail({ from: [{ email: 'carol@a.example' }] }), 'request', own, ['a.example']);
      expect(result.reason).toBe('sender_mismatch_unverified');
    });
  });
});

describe('findParticipantByEmail', () => {
  it('finds participant by direct email match', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        p1: makeParticipant({ email: 'alice@example.com', name: 'Alice' }),
      },
    };
    const result = findParticipantByEmail(event, 'alice@example.com');
    expect(result).toBeTruthy();
    expect(result!.id).toBe('p1');
    expect(result!.participant.name).toBe('Alice');
  });

  it('matches case-insensitively', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        p1: makeParticipant({ email: 'Alice@Example.COM' }),
      },
    };
    expect(findParticipantByEmail(event, 'alice@example.com')).toBeTruthy();
  });

  it('finds participant by sendTo mailto', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        p1: makeParticipant({ email: '', sendTo: { imip: 'mailto:bob@example.com' } }),
      },
    };
    const result = findParticipantByEmail(event, 'bob@example.com');
    expect(result).toBeTruthy();
    expect(result!.id).toBe('p1');
  });

  it('returns null when no match', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        p1: makeParticipant({ email: 'alice@example.com' }),
      },
    };
    expect(findParticipantByEmail(event, 'unknown@example.com')).toBeNull();
  });

  it('returns null with no participants', () => {
    expect(findParticipantByEmail({}, 'test@example.com')).toBeNull();
  });

  it('returns null with empty email', () => {
    const event: Partial<CalendarEvent> = {
      participants: {
        p1: makeParticipant({ email: 'alice@example.com' }),
      },
    };
    expect(findParticipantByEmail(event, '')).toBeNull();
  });
});

describe('invitation times across time zones (#1252)', () => {
  // A process zone that differs from both the organizer's and the viewer's,
  // so reading a LocalDateTime as browser-local would show up as a shift.
  let originalTZ: string | undefined;
  beforeAll(() => {
    originalTZ = process.env.TZ;
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  // The banner's options for a user in `timeZone`. Intl writes ranges with
  // thin spaces around the dash; the expectations use plain ones.
  const formatIn = (timeZone: string, hour12 = false) => ({ locale: 'en-US', timeZone, hour12 });
  const plain = (text: string) => text.replace(/[\u2009\u202f]/g, ' ');

  // CalendarEvent/parse output for the Exchange invite in the issue.
  const londonInvite: Partial<CalendarEvent> = {
    title: 'Sync',
    start: '2026-10-20T15:00:00',
    timeZone: 'Europe/London',
    duration: 'PT25M',
  };

  it('resolves start + timeZone to a real instant when there is no utcStart', () => {
    const summary = formatEventSummary(londonInvite);
    expect(summary.start).toBe('2026-10-20T14:00:00.000Z');
    expect(summary.end).toBe('2026-10-20T14:25:00.000Z');
    expect(summary.isFloating).toBe(false);
  });

  it('shows the invite in the viewer zone, the date once, and its own times after it (pim-23)', () => {
    const summary = formatEventSummary(londonInvite);
    expect(plain(formatInvitationSchedule(summary, formatIn('Europe/Warsaw'))))
      .toBe('Tue, Oct 20, 16:00 – 16:25 (15:00 – 15:25 London)');
    expect(plain(formatInvitationSchedule(summary, formatIn('America/New_York', true))))
      .toBe('Tue, Oct 20, 10:00 – 10:25 AM (3:00 – 3:25 PM London)');
  });

  it('shows no zone for an invite on the viewer clock (pim-23)', () => {
    const berlin = formatEventSummary({ title: 'Sprint planning', start: '2026-11-05T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H30M' });
    expect(plain(formatInvitationSchedule(berlin, formatIn('Europe/Berlin')))).toBe('Thu, Nov 5, 10:00 – 11:30');
    // Another zone with the same clock that day says nothing either.
    expect(plain(formatInvitationSchedule(berlin, formatIn('Europe/Paris')))).toBe('Thu, Nov 5, 10:00 – 11:30');
  });

  it('gives the event zone its date when its day there is another (pim-23)', () => {
    const tokyo = formatEventSummary({ start: '2026-11-06T08:00:00', timeZone: 'Asia/Tokyo', duration: 'PT1H' });
    expect(plain(formatInvitationSchedule(tokyo, formatIn('Europe/Berlin'))))
      .toBe('Fri, Nov 6, 00:00 – 01:00 (08:00 – 09:00 Tokyo)');
    expect(plain(formatInvitationSchedule(tokyo, formatIn('America/New_York'))))
      .toBe('Thu, Nov 5, 18:00 – 19:00 (Fri, Nov 6, 08:00 – 09:00 Tokyo)');
  });

  it('treats a UTC start as UTC', () => {
    const summary = formatEventSummary({ start: '2026-10-20T14:00:00', timeZone: 'Etc/UTC', duration: 'PT1H' });
    expect(summary.start).toBe('2026-10-20T14:00:00.000Z');
    expect(summary.end).toBe('2026-10-20T15:00:00.000Z');
  });

  it('keeps nominal days in the event zone across a DST change', () => {
    // Oct 25 2026 is the end of BST: 15:00 the next day is 15:00 GMT.
    const summary = formatEventSummary({ start: '2026-10-24T15:00:00', timeZone: 'Europe/London', duration: 'P1DT1H' });
    expect(summary.start).toBe('2026-10-24T14:00:00.000Z');
    expect(summary.end).toBe('2026-10-25T16:00:00.000Z');
  });

  it('shows floating times as the same wall clock everywhere, without a zone label', () => {
    const summary = formatEventSummary({ start: '2026-10-20T15:00:00', timeZone: null, duration: 'PT30M' });
    expect(summary.isFloating).toBe(true);
    expect(plain(formatInvitationSchedule(summary, formatIn('Asia/Tokyo'))))
      .toBe('Tue, Oct 20, 15:00 – 15:30');
  });

  it('does not shift all-day dates in zones west or east of UTC', () => {
    const oneDay = formatEventSummary({ start: '2026-03-16T00:00:00', duration: 'P1D', showWithoutTime: true, timeZone: 'Europe/London' });
    expect(formatInvitationSchedule(oneDay, formatIn('America/Los_Angeles'))).toBe('Mon, Mar 16');
    expect(formatInvitationSchedule(oneDay, formatIn('Pacific/Auckland'))).toBe('Mon, Mar 16');

    const threeDays = formatEventSummary({
      start: '2026-03-16T00:00:00',
      showWithoutTime: true,
      utcStart: '2026-03-16T00:00:00Z',
      utcEnd: '2026-03-19T00:00:00Z',
    });
    expect(plain(formatInvitationSchedule(threeDays, formatIn('America/Los_Angeles')))).toBe('Mon, Mar 16 – Wed, Mar 18');
  });

  it('shows only the start for a zero-duration event', () => {
    const summary = formatEventSummary({
      ...londonInvite,
      duration: 'PT0S',
      utcStart: '2026-10-20T14:00:00Z',
      utcEnd: '2026-10-20T14:00:00Z',
    });
    expect(plain(formatInvitationSchedule(summary, formatIn('Europe/Warsaw'))))
      .toBe('Tue, Oct 20, 16:00 (15:00 London)');
  });

  it('still prefers the server utcStart/utcEnd when present', () => {
    const summary = formatEventSummary({
      ...londonInvite,
      utcStart: '2026-10-20T14:00:00Z',
      utcEnd: '2026-10-20T14:25:00Z',
    });
    expect(plain(formatInvitationSchedule(summary, formatIn('UTC'))))
      .toBe('Tue, Oct 20, 14:00 – 14:25 (15:00 – 15:25 London)');
  });
});
