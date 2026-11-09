import { describe, expect, it } from 'vitest';
import { accountOwnerOf, resolveAnswerTargets, sentByPatchValue, type ResolveAnswerInput } from '../calendar-delegate';
import { CALENDAR_PRESETS } from '@/lib/jmap/share-rights';
import type { CalendarEvent } from '@/lib/jmap/types';

const participant = (email: string, extra: Record<string, unknown> = {}) => ({
  '@type': 'Participant', name: email.split('@')[0], email, calendarAddress: `mailto:${email}`,
  roles: { attendee: true }, participationStatus: 'needs-action', ...extra,
});

function invitation(attendees: string[], extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const participants: Record<string, unknown> = {
    carol: participant('carol@example.org', { roles: { owner: true }, participationStatus: 'accepted' }),
  };
  for (const a of attendees) participants[a.split('@')[0]] = participant(a);
  return {
    id: 'alice:e1', uid: 'u1', title: 'Planning', start: '2026-11-04T14:00:00', duration: 'PT1H',
    calendarIds: { 'alice:b': true }, isShared: true, accountId: 'alice',
    organizerCalendarAddress: 'mailto:carol@example.org',
    participants, ...extra,
  } as unknown as CalendarEvent;
}

const ALICE = accountOwnerOf({ id: 'alice', type: 'individual', name: 'alice@example.org', description: 'Alice Doe', email: 'alice@example.org' }, 'alice@example.org')!;
const TEAM = accountOwnerOf({ id: 'team', type: 'group', name: 'team@example.org', description: 'Team', email: 'team@example.org' }, 'team@example.org')!;
const write = { isShared: true, myRights: CALENDAR_PRESETS.readWrite };
const base = (event: CalendarEvent, extra: Partial<ResolveAnswerInput> = {}): ResolveAnswerInput => ({
  event, calendar: write, userEmails: ['bob@example.org'], canRsvpSelf: false, owner: ALICE, server016: false, ...extra,
});

describe('resolveAnswerTargets', () => {
  it('answers for the owner of a shared calendar with SENT-BY mailto:<delegate>', () => {
    const view = resolveAnswerTargets(base(invitation(['alice@example.org'])));
    expect(view.note).toBeNull();
    expect(view.targets).toEqual([{
      kind: 'owner', eventId: 'alice:e1', participantId: 'alice', status: 'needs-action',
      ownerName: 'Alice Doe', sentBy: 'mailto:bob@example.org',
    }]);
  });

  it('answers as a group mailbox without SENT-BY', () => {
    const view = resolveAnswerTargets(base(invitation(['team@example.org'], { accountId: 'team' }), { owner: TEAM }));
    expect(view.targets).toHaveLength(1);
    expect(view.targets[0]).toMatchObject({ kind: 'owner', participantId: 'team', ownerName: 'Team' });
    expect(view.targets[0].sentBy).toBeUndefined();
  });

  it('answers as the group also when the member has the group address as an identity', () => {
    const view = resolveAnswerTargets(base(invitation(['team@example.org'], { accountId: 'team' }), {
      owner: TEAM, userEmails: ['bob@example.org', 'team@example.org'], canRsvpSelf: true,
    }));
    expect(view.targets.map((t) => [t.kind, t.participantId, t.sentBy])).toEqual([['owner', 'team', undefined]]);
  });

  it('offers no answer for the owner without edit access, and says why', () => {
    for (const rights of [CALENDAR_PRESETS.read, { ...CALENDAR_PRESETS.read, mayRSVP: true }]) {
      const view = resolveAnswerTargets(base(invitation(['alice@example.org']), { calendar: { isShared: true, myRights: rights } }));
      expect(view.targets).toEqual([]);
      expect(view.note).toEqual({ kind: 'no_write', owner: 'Alice Doe' });
    }
  });

  it('shows both answers on 1.0 when the user is invited too: the owner\'s here, the user\'s on their own copy', () => {
    const shared = invitation(['alice@example.org', 'bob@example.org']);
    const own = { ...invitation(['alice@example.org', 'bob@example.org']), id: 'e7', isShared: false, accountId: undefined } as CalendarEvent;
    const view = resolveAnswerTargets(base(shared, { canRsvpSelf: true, ownCopy: own }));
    expect(view.targets.map((t) => [t.kind, t.eventId, t.participantId])).toEqual([
      ['owner', 'alice:e1', 'alice'],
      ['self', 'e7', 'bob'],
    ]);
  });

  it('refuses the owner\'s answer on 0.16 when the user is invited too', () => {
    // 0.16 answered "Cannot modify address of the event" live: it counts the
    // delegate's and the owner's addresses as its own.
    const shared = invitation(['alice@example.org', 'bob@example.org']);
    const own = { ...shared, id: 'e7', isShared: false } as CalendarEvent;
    const view = resolveAnswerTargets(base(shared, { canRsvpSelf: true, ownCopy: own, server016: true }));
    expect(view.note).toEqual({ kind: 'also_invited', owner: 'Alice Doe' });
    expect(view.targets.map((t) => [t.kind, t.eventId])).toEqual([['self', 'e7']]);
    // Only invited alone, 0.16 answers for the owner as 1.0 does.
    expect(resolveAnswerTargets(base(invitation(['alice@example.org']), { server016: true })).targets[0].kind).toBe('owner');
  });

  it('says who answered for the owner, and for the user in their own calendar', () => {
    const shared = invitation(['alice@example.org']);
    (shared.participants!.alice as { sentBy?: string }).sentBy = 'mailto:bob@example.org';
    expect(resolveAnswerTargets(base(shared)).answeredBy).toBe('bob@example.org');
    const own = { ...shared, isShared: false } as CalendarEvent;
    const view = resolveAnswerTargets({ event: own, calendar: { isShared: false, myRights: CALENDAR_PRESETS.manager }, userEmails: ['alice@example.org'], canRsvpSelf: true, owner: null, server016: false });
    expect(view.targets.map((t) => t.kind)).toEqual(['self']);
    expect(view.answeredBy).toBe('bob@example.org');
  });

  it('keeps the existing behaviour where the owner is the organiser or not invited', () => {
    const organised = invitation(['dave@example.org'], { organizerCalendarAddress: 'mailto:alice@example.org' });
    expect(resolveAnswerTargets(base(organised)).targets).toEqual([]);
    const notInvited = invitation(['dave@example.org']);
    expect(resolveAnswerTargets(base(notInvited)).targets).toEqual([]);
    expect(resolveAnswerTargets(base(notInvited)).note).toBeNull();
  });
});

describe('accountOwnerOf', () => {
  it('falls back to the account name when the principal is unknown', () => {
    expect(accountOwnerOf(null, 'Alice@Example.org')).toEqual({ name: 'Alice@Example.org', emails: ['alice@example.org'], isGroup: false });
    expect(accountOwnerOf(null, 'shared-calendar')).toBeNull();
  });
});

describe('sentByPatchValue', () => {
  it('sets, clears or leaves sentBy', () => {
    expect(sentByPatchValue({}, 'mailto:bob@example.org')).toBe('mailto:bob@example.org');
    expect(sentByPatchValue({ sentBy: 'mailto:bob@example.org' }, undefined)).toBeNull();
    expect(sentByPatchValue({}, undefined)).toBeUndefined();
  });
});
