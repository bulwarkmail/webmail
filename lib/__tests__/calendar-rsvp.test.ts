import { describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '../jmap/client-interface';
import type { CalendarEvent } from '../jmap/types';
import { answerInvitation, attendeeOf, joinAddress, type RsvpRequest } from '../calendar-rsvp';

// The banner's three ways of answering an invitation, now in one place that
// calendar.respond uses too.

const me = { email: 'bob@example.org', roles: { attendee: true }, participationStatus: 'needs-action' };
const organiser = { email: 'alice@example.org', roles: { owner: true } };
const parsed = {
  uid: 'u1', title: 'Team offsite', organizerCalendarAddress: 'mailto:alice@example.org',
  participants: { p1: organiser, p2: me },
} as unknown as Partial<CalendarEvent>;

function request(over: Partial<RsvpRequest> = {}): RsvpRequest & { store: { rsvpEvent: ReturnType<typeof vi.fn>; updateEvent: ReturnType<typeof vi.fn>; importEvents: ReturnType<typeof vi.fn> } } {
  const imported = { id: 'new', uid: 'u1', participants: { p1: organiser, p2: me } } as unknown as CalendarEvent;
  return {
    client: {} as IJMAPClient,
    store: {
      rsvpEvent: vi.fn(async () => true),
      updateEvent: vi.fn(async () => true),
      importEvents: vi.fn(async () => 1),
      events: () => [imported],
    },
    parsedEvent: parsed,
    existingEvent: null,
    myParticipant: { id: 'p2', participant: me as never },
    actingEmails: ['bob@example.org'],
    calendarId: 'cal1',
    sharedMailAccount: null,
    resolveExisting: async () => null,
    ...over,
  } as never;
}

describe('answerInvitation', () => {
  it('answers on the stored copy when the user is among its participants', async () => {
    const stored = { id: 'e1', uid: 'u1', participants: { a: organiser, b: me } } as unknown as CalendarEvent;
    const req = request({ existingEvent: stored, resolveExisting: async () => stored });
    expect(await answerInvitation(req, 'accepted')).toBe('answered');
    expect(req.store.rsvpEvent).toHaveBeenCalledWith(req.client, 'e1', 'b', 'accepted', { imip: 'mailto:alice@example.org' });
    expect(req.store.importEvents).not.toHaveBeenCalled();
  });

  it('repairs a stored copy that lost its participants', async () => {
    const stored = { id: 'e1', uid: 'u1', participants: null } as unknown as CalendarEvent;
    const req = request({ existingEvent: stored, resolveExisting: async () => stored });
    expect(await answerInvitation(req, 'tentative')).toBe('answered');
    expect(req.store.updateEvent).toHaveBeenCalledWith(req.client, 'e1', expect.objectContaining({
      participants: expect.objectContaining({ p2: expect.objectContaining({ participationStatus: 'tentative' }) }),
      organizerCalendarAddress: 'mailto:alice@example.org',
    }), true);
  });

  it('adds the invitation to the calendar first when it is not there, then answers', async () => {
    const req = request();
    expect(await answerInvitation(req, 'declined')).toBe('answered');
    expect(req.store.importEvents).toHaveBeenCalledWith(req.client, [parsed], 'cal1', { throwIfNoneImported: true });
    expect(req.store.rsvpEvent).toHaveBeenCalledWith(req.client, 'new', 'p2', 'declined', { imip: 'mailto:alice@example.org' });
  });

  it('finds the new copy on the server when the store doesn’t hold it', async () => {
    const base = request();
    const req = request({ store: { ...base.store, events: () => [] }, findImported: async () => ({ id: 'srv', uid: 'u1', participants: { p2: me } } as never) } as never);
    expect(await answerInvitation(req, 'accepted')).toBe('answered');
    expect(req.store.rsvpEvent).toHaveBeenCalledWith(req.client, 'srv', 'p2', 'accepted', { imip: 'mailto:alice@example.org' });
  });

  it('says when a plugin stopped it, when it only added the event, and when it can\'t', async () => {
    expect(await answerInvitation(request({ store: { ...request().store, importEvents: vi.fn(async () => null) } } as never), 'accepted')).toBe('stopped');
    expect(await answerInvitation(request({ myParticipant: null, store: { ...request().store, events: () => [{ id: 'new', uid: 'u1', participants: {} } as never] } } as never), 'accepted')).toBe('added');
    expect(await answerInvitation(request({ calendarId: undefined }), 'accepted')).toBe('failed');
  });

  // A forwarded invitation doesn't list the user (#1797). Stalwart sends the
  // organiser a REPLY only when the copy is created with the user in it.
  it('joins an invitation that doesn\'t list the user, so the organiser gets the answer', async () => {
    const forwarded = { ...parsed, participants: { p1: organiser, p3: { email: 'carol@example.org', roles: { attendee: true } } } } as unknown as Partial<CalendarEvent>;
    const req = request({ parsedEvent: forwarded, myParticipant: null, joinAs: { email: 'bob@example.org', name: 'Bob' } });
    expect(await answerInvitation(req, 'tentative')).toBe('answered');
    expect(req.store.importEvents).toHaveBeenCalledWith(req.client, [expect.objectContaining({
      uid: 'u1',
      participants: expect.objectContaining({
        p1: organiser,
        joined: expect.objectContaining({ calendarAddress: 'mailto:bob@example.org', name: 'Bob', participationStatus: 'tentative', roles: { attendee: true } }),
      }),
    })], 'cal1', { throwIfNoneImported: true, sendSchedulingMessages: true });
    expect(req.store.rsvpEvent).not.toHaveBeenCalled();
  });

  it('only adds an unlisted invitation when there is no one to join as', async () => {
    const forwarded = { ...parsed, participants: { p1: organiser } } as unknown as Partial<CalendarEvent>;
    const store = { ...request().store, events: () => [{ id: 'new', uid: 'u1', participants: { p1: organiser } } as never] };
    const plain = request({ parsedEvent: forwarded, myParticipant: null, store } as never);
    expect(await answerInvitation(plain, 'accepted')).toBe('added');
    expect(plain.store.importEvents).toHaveBeenCalledWith(plain.client, [forwarded], 'cal1', { throwIfNoneImported: true });
  });

  it('joins with the address the message went to', () => {
    const identities = [{ email: 'bob@example.org', name: 'Bob' }, { email: 'sales@example.org', name: 'Sales' }];
    expect(joinAddress({ to: [{ name: '', email: 'SALES@example.org' }], cc: null } as never, identities)).toEqual({ email: 'sales@example.org', name: 'Sales' });
    expect(joinAddress({ to: [{ name: '', email: 'list@example.org' }] } as never, identities)).toEqual({ email: 'bob@example.org', name: 'Bob' });
    expect(joinAddress({ to: [] } as never, [])).toBeUndefined();
  });

  it('treats an owner who isn\'t an attendee as the organiser', () => {
    expect(attendeeOf({ id: 'p1', participant: organiser as never })).toEqual({ participant: null, isOrganizer: true });
    expect(attendeeOf({ id: 'p2', participant: me as never }).isOrganizer).toBe(false);
  });
});
