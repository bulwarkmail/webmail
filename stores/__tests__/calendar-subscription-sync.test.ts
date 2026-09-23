import { beforeEach, describe, expect, it } from 'vitest';
import { useCalendarStore, type ICalSubscription } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

function makeSubscription(overrides: Partial<ICalSubscription> = {}): ICalSubscription {
  return {
    id: 'sub-test-id',
    url: 'https://example.com/calendar.ics',
    calendarId: 'cal-123',
    name: 'Test Subscription',
    color: '#3b82f6',
    refreshInterval: 60,
    lastRefreshed: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const mockClient: IJMAPClient = {
  deleteCalendar: async () => {},
  getAccountId: () => 'acc-1',
} as unknown as IJMAPClient;

beforeEach(() => {
  useCalendarStore.setState({
    calendars: [],
    events: [],
    icalSubscriptions: [],
    deletedSubscriptionIds: {},
  });
});

describe('removeICalSubscription', () => {
  it('records a tombstone so the deletion can propagate through sync', async () => {
    useCalendarStore.setState({
      icalSubscriptions: [makeSubscription({ id: 'sub-a' })],
    });

    await useCalendarStore.getState().removeICalSubscription(mockClient, 'sub-a');

    const state = useCalendarStore.getState();
    expect(state.icalSubscriptions).toEqual([]);
    expect(Object.keys(state.deletedSubscriptionIds)).toEqual(['sub-a']);
    expect(Date.parse(state.deletedSubscriptionIds['sub-a'])).not.toBeNaN();
  });
});

describe('applySyncedState', () => {
  it('merges by id on server loads instead of clobbering local subscriptions', () => {
    useCalendarStore.setState({
      icalSubscriptions: [makeSubscription({ id: 'local-sub' })],
    });

    useCalendarStore.getState().applySyncedState(
      [makeSubscription({ id: 'remote-sub' })],
      {},
      { merge: true }
    );

    const ids = useCalendarStore.getState().icalSubscriptions.map((s) => s.id).sort();
    expect(ids).toEqual(['local-sub', 'remote-sub']);
  });

  it('replaces wholesale on file imports', () => {
    useCalendarStore.setState({
      icalSubscriptions: [makeSubscription({ id: 'local-sub' })],
    });

    useCalendarStore.getState().applySyncedState(
      [makeSubscription({ id: 'imported-sub' })],
      {},
      { merge: false }
    );

    expect(useCalendarStore.getState().icalSubscriptions.map((s) => s.id)).toEqual(['imported-sub']);
  });

  it('leaves the store untouched when the blob has no subscriptions array', () => {
    useCalendarStore.setState({
      icalSubscriptions: [makeSubscription({ id: 'local-sub' })],
    });

    useCalendarStore.getState().applySyncedState(undefined, undefined, { merge: true });

    expect(useCalendarStore.getState().icalSubscriptions.map((s) => s.id)).toEqual(['local-sub']);
  });

  it('removes subscriptions deleted on another device', () => {
    const deletedAt = new Date(Date.now() - 1000).toISOString();
    useCalendarStore.setState({
      icalSubscriptions: [
        makeSubscription({ id: 'sub-a' }),
        makeSubscription({ id: 'sub-b' }),
      ],
    });

    useCalendarStore.getState().applySyncedState(
      [makeSubscription({ id: 'sub-b' })],
      { 'sub-a': deletedAt },
      { merge: true }
    );

    const state = useCalendarStore.getState();
    expect(state.icalSubscriptions.map((s) => s.id)).toEqual(['sub-b']);
    expect(state.deletedSubscriptionIds).toEqual({ 'sub-a': deletedAt });
  });
});
