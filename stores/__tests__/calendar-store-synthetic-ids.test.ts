import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCalendarStore, resolveMutationTarget } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';

// Occurrences produced by server-side recurrence expansion carry synthetic
// ids (lib/recurrence-instances.ts). The store writes "this occurrence only"
// changes through that id, resolves whole-series operations (RSVP) and
// non-recurring events to the base event, falls back to a recurrence
// override on the base event when the server predates synthetic-id writes,
// and reloads the visible range afterwards because the ids reshuffle.

const UNSUPPORTED = 'Updating synthetic ids is not yet supported.';
const UNSUPPORTED_DESTROY = 'Deleting synthetic ids is not yet supported.';

function occurrence(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'maaaaab',
    originalId: 'maaaaab',
    baseEventId: 'b',
    uid: 'series@example.com',
    title: 'Daily standup',
    start: '2026-09-08T10:00:00',
    duration: 'PT1H',
    timeZone: 'Europe/Berlin',
    utcStart: '2026-09-08T08:00:00Z',
    utcEnd: '2026-09-08T09:00:00Z',
    showWithoutTime: false,
    recurrenceId: '2026-09-08T10:00:00',
    recurrenceIdTimeZone: 'Europe/Berlin',
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily', count: 5 }] as unknown as CalendarEvent['recurrenceRules'],
    recurrenceOverrides: { '2026-09-09T10:00:00': { start: '2026-09-09T14:00:00', title: 'Moved' } },
    excludedRecurrenceRules: null,
    calendarIds: { f: true },
    participants: {
      p1: { '@type': 'Participant', name: 'Me', email: 'me@example.com', participationStatus: 'needs-action' },
    } as unknown as CalendarEvent['participants'],
    ...overrides,
  } as CalendarEvent;
}

function fakeClient(overrides: Partial<Record<keyof IJMAPClient, unknown>> = {}): IJMAPClient & {
  updateCalendarEvent: ReturnType<typeof vi.fn>;
  deleteCalendarEvent: ReturnType<typeof vi.fn>;
  queryAllCalendarEvents: ReturnType<typeof vi.fn>;
} {
  return {
    updateCalendarEvent: vi.fn().mockResolvedValue(undefined),
    deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
    queryAllCalendarEvents: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as never;
}

const RANGE = ['2026-09-01T00:00:00', '2026-09-30T00:00:00'] as const;

beforeEach(() => {
  useCalendarStore.getState().clearState();
  useCalendarStore.setState({ events: [], calendars: [], error: null });
});

describe('resolveMutationTarget', () => {
  it('addresses an occurrence of a series by its synthetic id', () => {
    const target = resolveMutationTarget([occurrence()], 'maaaaab', 'occurrence');
    expect(target).toMatchObject({ realId: 'maaaaab', isOccurrence: true });
  });

  it('addresses a whole-series operation and a non-recurring occurrence by the base id', () => {
    expect(resolveMutationTarget([occurrence()], 'maaaaab', 'series')).toMatchObject({ realId: 'b', isOccurrence: false });
    const single = occurrence({ id: 'eaaaaad', originalId: 'eaaaaad', baseEventId: 'd', recurrenceId: null, recurrenceRules: null });
    expect(resolveMutationTarget([single], 'eaaaaad', 'occurrence')).toMatchObject({ realId: 'd', isOccurrence: false });
  });

  it('routes a base event that is only in view through its occurrences with that account', () => {
    const shared = occurrence({ id: 'acct2:maaaaab', originalId: 'maaaaab', accountId: 'acct2', isShared: true });
    expect(resolveMutationTarget([shared], 'acct2:b', 'occurrence')).toEqual({
      realId: 'b', targetAccountId: 'acct2', localAccountId: undefined, isOccurrence: false,
    });
    const aggregated = occurrence({ id: 'A@h::maaaaab', originalId: 'maaaaab', localAccountId: 'A@h' });
    expect(resolveMutationTarget([aggregated], 'A@h::b', 'occurrence')).toMatchObject({ realId: 'b', localAccountId: 'A@h' });
  });

  it('leaves events without synthetic ids exactly as before', () => {
    const legacy = occurrence({ id: 'x', originalId: 'x', baseEventId: 'x', recurrenceId: null });
    expect(resolveMutationTarget([legacy], 'x', 'occurrence')).toMatchObject({ realId: 'x', isOccurrence: false });
    const clientExpanded = occurrence({ id: 'b:2026-09-08T10:00:00', originalId: 'b', baseEventId: undefined });
    expect(resolveMutationTarget([clientExpanded], 'b:2026-09-08T10:00:00', 'occurrence')).toMatchObject({ realId: 'b', isOccurrence: false });
    expect(resolveMutationTarget([], 'unknown', 'occurrence')).toEqual({ realId: 'unknown', isOccurrence: false });
  });
});

describe('updateEvent on an expanded occurrence', () => {
  it('patches the occurrence through its synthetic id, minus per-event keys', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [occurrence()] });

    await useCalendarStore.getState().updateEvent(client, 'maaaaab', {
      title: 'Renamed', start: '2026-09-08T11:00:00', calendarIds: { g: true },
    });

    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(1);
    // The occurrence has no override yet: its details (here the participants) go along.
    expect(client.updateCalendarEvent).toHaveBeenCalledWith(
      'maaaaab', { title: 'Renamed', start: '2026-09-08T11:00:00', participants: occurrence().participants },
      undefined, undefined, undefined,
    );
    const stored = useCalendarStore.getState().events[0];
    expect(stored.title).toBe('Renamed');
    expect(stored.utcStart).toBe('2026-09-08T09:00:00.000Z');
  });

  it('falls back to a recurrence override on the base event when the server rejects synthetic ids', async () => {
    const client = fakeClient();
    client.updateCalendarEvent.mockRejectedValueOnce(new Error(UNSUPPORTED));
    useCalendarStore.setState({ events: [occurrence()] });

    await useCalendarStore.getState().updateEvent(client, 'maaaaab', { title: 'Renamed' }, true);

    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(2);
    expect(client.updateCalendarEvent).toHaveBeenNthCalledWith(
      1, 'maaaaab', { title: 'Renamed', participants: occurrence().participants }, true, undefined, undefined,
    );
    expect(client.updateCalendarEvent).toHaveBeenNthCalledWith(2, 'b', {
      'recurrenceOverrides/2026-09-08T10:00:00': {
        start: '2026-09-08T10:00:00', duration: 'PT1H', title: 'Renamed', participants: occurrence().participants,
      },
    }, true, undefined);
    expect(useCalendarStore.getState().events[0].title).toBe('Renamed');

    // The rejection is remembered: the next change skips the doomed attempt.
    client.updateCalendarEvent.mockClear();
    await useCalendarStore.getState().updateEvent(client, 'maaaaab', { title: 'Again' });
    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(client.updateCalendarEvent.mock.calls[0][0]).toBe('b');
  });

  it('rethrows other failures without falling back', async () => {
    const client = fakeClient();
    client.updateCalendarEvent.mockRejectedValueOnce(new Error('This property cannot be modified on a single occurrence.'));
    useCalendarStore.setState({ events: [occurrence()] });

    await expect(useCalendarStore.getState().updateEvent(client, 'maaaaab', { title: 'x' })).rejects.toThrow('single occurrence');
    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(useCalendarStore.getState().error).toBe('Failed to update event');
  });

  it('targets the base event for the single occurrence of a non-recurring event', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [occurrence({ id: 'eaaaaad', originalId: 'eaaaaad', baseEventId: 'd', recurrenceId: null, recurrenceRules: null })] });

    await useCalendarStore.getState().updateEvent(client, 'eaaaaad', { title: 'One off, renamed' });

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('d', { title: 'One off, renamed' }, undefined, undefined);
  });

  it('routes a base event addressed through an occurrence to that occurrence’s account', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [occurrence({ id: 'acct2:maaaaab', originalId: 'maaaaab', accountId: 'acct2', isShared: true })] });

    await useCalendarStore.getState().updateEvent(client, 'acct2:b', { title: 'Whole series' });

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('b', { title: 'Whole series' }, undefined, 'acct2');
  });

  it('reloads the visible range silently after the change, since synthetic ids reshuffle', async () => {
    const client = fakeClient();
    client.queryAllCalendarEvents.mockResolvedValue([occurrence()]);
    await useCalendarStore.getState().fetchEvents(client, RANGE[0], RANGE[1]);
    expect(client.queryAllCalendarEvents).toHaveBeenCalledTimes(1);
    const loadingStates: boolean[] = [];
    const unsubscribe = useCalendarStore.subscribe((s) => loadingStates.push(s.isLoadingEvents));

    await useCalendarStore.getState().updateEvent(client, 'maaaaab', { title: 'Renamed' });
    unsubscribe();

    expect(client.queryAllCalendarEvents).toHaveBeenCalledTimes(2);
    expect(client.queryAllCalendarEvents).toHaveBeenLastCalledWith({ after: RANGE[0], before: RANGE[1] });
    expect(loadingStates.every((v) => v === false)).toBe(true);
  });

  it('also reloads after a change to a base event whose occurrences are in view', async () => {
    const client = fakeClient();
    client.queryAllCalendarEvents.mockResolvedValue([occurrence()]);
    await useCalendarStore.getState().fetchEvents(client, RANGE[0], RANGE[1]);

    await useCalendarStore.getState().updateEvent(client, 'b', { title: 'Whole series' });

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('b', { title: 'Whole series' }, undefined, undefined);
    expect(client.queryAllCalendarEvents).toHaveBeenCalledTimes(2);
  });

  it('does not reload after changing an ordinary event', async () => {
    const client = fakeClient();
    const plain = occurrence({ id: 'x', originalId: 'x', baseEventId: 'x', recurrenceId: null, recurrenceRules: null });
    client.queryAllCalendarEvents.mockResolvedValue([plain]);
    await useCalendarStore.getState().fetchEvents(client, RANGE[0], RANGE[1]);

    await useCalendarStore.getState().updateEvent(client, 'x', { title: 'Renamed' });

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('x', { title: 'Renamed' }, undefined, undefined);
    expect(client.queryAllCalendarEvents).toHaveBeenCalledTimes(1);
  });
});

describe('deleteEvent on an expanded occurrence', () => {
  it('destroys the occurrence through its synthetic id and drops it from the store', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [occurrence()], selectedEventId: 'maaaaab' });

    await useCalendarStore.getState().deleteEvent(client, 'maaaaab', true);

    expect(client.deleteCalendarEvent).toHaveBeenCalledWith('maaaaab', true, undefined);
    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().events).toEqual([]);
    expect(useCalendarStore.getState().selectedEventId).toBeNull();
  });

  it('excludes the occurrence on the base event when the server rejects synthetic ids', async () => {
    const client = fakeClient();
    client.deleteCalendarEvent.mockRejectedValueOnce(new Error(UNSUPPORTED_DESTROY));
    useCalendarStore.setState({ events: [occurrence()] });

    await useCalendarStore.getState().deleteEvent(client, 'maaaaab');

    expect(client.updateCalendarEvent).toHaveBeenCalledWith(
      'b', { 'recurrenceOverrides/2026-09-08T10:00:00': { excluded: true } }, undefined, undefined,
    );
    expect(useCalendarStore.getState().events).toEqual([]);
  });

  it('deletes the base event for the single occurrence of a non-recurring event', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [occurrence({ id: 'eaaaaad', originalId: 'eaaaaad', baseEventId: 'd', recurrenceId: null, recurrenceRules: null })] });

    await useCalendarStore.getState().deleteEvent(client, 'eaaaaad');

    expect(client.deleteCalendarEvent).toHaveBeenCalledWith('d', undefined, undefined);
  });
});

describe('an occurrence expanded in the browser (older servers)', () => {
  // Client-side expansion: `<master id>:<recurrenceId>`, no baseEventId,
  // the master's rules and overrides copied onto the occurrence.
  const browserOccurrence = (overrides: Partial<CalendarEvent> = {}) => occurrence({
    id: 'b:2026-09-08T10:00:00', originalId: 'b', baseEventId: undefined, recurrenceOverrides: null, ...overrides,
  });

  it('writes a drag as an override on the base event, not as a new start for the series', async () => {
    const client = fakeClient();
    const occ = browserOccurrence();
    useCalendarStore.setState({ events: [occ] });

    await useCalendarStore.getState().updateEvent(client, occ.id, { start: '2026-09-08T12:00:00' });

    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('b', {
      recurrenceOverrides: {
        '2026-09-08T10:00:00': {
          start: '2026-09-08T12:00:00',
          duration: 'PT1H',
          title: 'Daily standup',
          participants: occ.participants,
        },
      },
    }, undefined, undefined);
  });

  it('patches the override entry when the series already has overrides', async () => {
    const client = fakeClient();
    const occ = browserOccurrence({ recurrenceOverrides: { '2026-09-09T10:00:00': { title: 'Moved' } } });
    useCalendarStore.setState({ events: [occ] });

    await useCalendarStore.getState().updateEvent(client, occ.id, { description: 'Bring slides' });

    expect(Object.keys(client.updateCalendarEvent.mock.calls[0][1])).toEqual(['recurrenceOverrides/2026-09-08T10:00:00']);
  });

  it('deletes one occurrence by excluding it, never the whole series', async () => {
    const client = fakeClient();
    const occ = browserOccurrence();
    useCalendarStore.setState({ events: [occ] });

    await useCalendarStore.getState().deleteEvent(client, occ.id, true);

    expect(client.deleteCalendarEvent).not.toHaveBeenCalled();
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('b', {
      recurrenceOverrides: { '2026-09-08T10:00:00': { excluded: true } },
    }, true, undefined);
  });
});

describe('rsvpEvent on an expanded occurrence', () => {
  it('answers for the whole series on the base event', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [occurrence()] });

    await useCalendarStore.getState().rsvpEvent(client, 'maaaaab', 'p1', 'accepted');

    expect(client.updateCalendarEvent).toHaveBeenCalledWith(
      'b', { 'participants/p1/participationStatus': 'accepted' }, true, undefined,
    );
    expect(useCalendarStore.getState().events[0].participants?.p1.participationStatus).toBe('accepted');
  });

  it('answers one occurrence through its synthetic id with the whole participants map', async () => {
    const client = fakeClient();
    const occ = occurrence({ sequence: 2 });
    useCalendarStore.setState({ events: [occ] });

    await useCalendarStore.getState().rsvpEvent(client, 'maaaaab', 'p1', 'declined', undefined, 'occurrence');

    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(1);
    // The occurrence has no override yet, so its details are copied into it,
    // and the series sequence is sent along.
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('maaaaab', {
      title: 'Daily standup',
      sequence: 2,
      participants: { p1: { ...occ.participants!.p1, participationStatus: 'declined' } },
    }, true, undefined, { keepSequence: true });
    expect(useCalendarStore.getState().events[0].participants?.p1.participationStatus).toBe('declined');
  });

  it('answers one occurrence as a recurrence override when the server rejects synthetic ids', async () => {
    const client = fakeClient();
    client.updateCalendarEvent.mockRejectedValueOnce(new Error(UNSUPPORTED));
    const occ = occurrence();
    useCalendarStore.setState({ events: [occ] });

    await useCalendarStore.getState().rsvpEvent(client, 'maaaaab', 'p1', 'tentative', undefined, 'occurrence');

    expect(client.updateCalendarEvent).toHaveBeenNthCalledWith(2, 'b', {
      'recurrenceOverrides/2026-09-08T10:00:00': {
        start: '2026-09-08T10:00:00',
        duration: 'PT1H',
        title: 'Daily standup',
        participants: { p1: { ...occ.participants!.p1, participationStatus: 'tentative' } },
      },
    }, true, undefined);
  });

  it('answers one occurrence expanded in the browser on its base event', async () => {
    const client = fakeClient();
    // Client-side expansion: `<master id>:<recurrenceId>`, no baseEventId,
    // the master's overrides copied onto the occurrence.
    const occ = occurrence({ id: 'b:2026-09-08T10:00:00', originalId: 'b', baseEventId: undefined, recurrenceOverrides: null });
    useCalendarStore.setState({ events: [occ] });

    await useCalendarStore.getState().rsvpEvent(client, occ.id, 'p1', 'declined', undefined, 'occurrence');

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('b', {
      recurrenceOverrides: {
        '2026-09-08T10:00:00': {
          start: '2026-09-08T10:00:00',
          duration: 'PT1H',
          title: 'Daily standup',
          participants: { p1: { ...occ.participants!.p1, participationStatus: 'declined' } },
        },
      },
    }, true, undefined);
  });

  it('refuses to answer an occurrence the participant is not on', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [occurrence()] });

    await expect(
      useCalendarStore.getState().rsvpEvent(client, 'maaaaab', 'p2', 'declined', undefined, 'occurrence'),
    ).rejects.toThrow();
    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
  });
});
