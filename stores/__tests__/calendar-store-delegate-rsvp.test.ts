import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';

// Answering for the calendar's owner (#634): the owner's participant gets
// the answer and sentBy = mailto:<delegate> in the owner's account, and an
// answer without sentBy clears an old one, or Stalwart sends the next reply
// with the delegate's SENT-BY still on it.

function sharedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'alice:e1',
    originalId: 'e1',
    uid: 'invite@example.org',
    title: 'Planning',
    start: '2026-11-04T14:00:00',
    duration: 'PT1H',
    timeZone: 'Etc/UTC',
    showWithoutTime: false,
    calendarIds: { 'alice:b': true },
    accountId: 'alice',
    isShared: true,
    organizerCalendarAddress: 'mailto:carol@example.org',
    participants: {
      carol: { '@type': 'Participant', name: 'Carol', email: 'carol@example.org', roles: { owner: true }, participationStatus: 'accepted' },
      alice: { '@type': 'Participant', name: 'Alice', email: 'alice@example.org', roles: { attendee: true }, participationStatus: 'needs-action' },
    } as unknown as CalendarEvent['participants'],
    ...overrides,
  } as CalendarEvent;
}

function fakeClient() {
  return { updateCalendarEvent: vi.fn().mockResolvedValue(undefined), queryAllCalendarEvents: vi.fn().mockResolvedValue([]) } as unknown as IJMAPClient & {
    updateCalendarEvent: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  useCalendarStore.getState().clearState();
});

describe('rsvpEvent for someone else', () => {
  it('sets the owner\'s answer and sentBy in the owner\'s account, with scheduling messages', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [sharedEvent()] });

    await useCalendarStore.getState().rsvpEvent(client, 'alice:e1', 'alice', 'accepted', undefined, 'series', { sentBy: 'mailto:bob@example.org' });

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('e1', {
      'participants/alice/participationStatus': 'accepted',
      'participants/alice/sentBy': 'mailto:bob@example.org',
    }, true, 'alice');
    const stored = useCalendarStore.getState().events[0].participants!.alice;
    expect(stored.participationStatus).toBe('accepted');
    expect(stored.sentBy).toBe('mailto:bob@example.org');
  });

  it('clears an old sentBy when the participant answers without one', async () => {
    const client = fakeClient();
    const event = sharedEvent({ isShared: false, accountId: undefined, id: 'e1' });
    event.participants!.alice.sentBy = 'mailto:bob@example.org';
    useCalendarStore.setState({ events: [event] });

    await useCalendarStore.getState().rsvpEvent(client, 'e1', 'alice', 'declined');

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('e1', {
      'participants/alice/participationStatus': 'declined',
      'participants/alice/sentBy': null,
    }, true, undefined);
    expect(useCalendarStore.getState().events[0].participants!.alice.sentBy).toBeUndefined();
  });

  it('sends no sentBy when there is none to set or clear', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [sharedEvent()] });

    await useCalendarStore.getState().rsvpEvent(client, 'alice:e1', 'alice', 'tentative');

    expect(client.updateCalendarEvent).toHaveBeenCalledWith('e1', { 'participants/alice/participationStatus': 'tentative' }, true, 'alice');
  });

  it('puts sentBy on the owner\'s participant when answering one occurrence', async () => {
    const client = fakeClient();
    const occurrence = sharedEvent({
      id: 'alice:maaaab', originalId: 'maaaab', baseEventId: 'e1', recurrenceId: '2026-11-04T14:00:00',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 3 }] as unknown as CalendarEvent['recurrenceRules'],
      utcStart: '2026-11-04T14:00:00Z', utcEnd: '2026-11-04T15:00:00Z',
    });
    useCalendarStore.setState({ events: [occurrence] });

    await useCalendarStore.getState().rsvpEvent(client, 'alice:maaaab', 'alice', 'accepted', undefined, 'occurrence', { sentBy: 'mailto:bob@example.org' });

    const [, patch] = client.updateCalendarEvent.mock.calls[0];
    expect(patch.participants.alice).toMatchObject({ participationStatus: 'accepted', sentBy: 'mailto:bob@example.org' });
    expect(patch.participants.carol).toEqual(occurrence.participants!.carol);
  });
});
