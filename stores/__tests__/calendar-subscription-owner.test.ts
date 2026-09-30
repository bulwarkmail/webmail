import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscriptionOwner, useCalendarStore } from '@/stores/calendar-store';

// A persisted iCal subscription was matched to an account by its bare JMAP
// account id - or not at all for subscriptions from older builds - and its
// calendar by a bare id. Stalwart hands out small ids ("b", "c") on every
// server, so refreshing it through another login diffed away the events of
// an unrelated calendar there, and "Remove" destroyed that calendar.

function fakeClient(server: string, username: string, jmapAccountId: string, calendars: Array<{ id: string; name: string }>) {
  const deleted: string[][] = [];
  const destroyedCalendars: string[] = [];
  const client = {
    getServerUrl: () => server,
    getUsername: () => username,
    getAccountId: () => jmapAccountId,
    getCalendarsAccountId: () => jmapAccountId,
    getCalendars: async () => calendars,
    uploadBlob: async () => ({ blobId: 'blob-feed' }),
    parseCalendarEvents: async () => [{ uid: 'feed-holiday-1', title: 'Public holiday', start: '2026-10-03T00:00:00' }],
    getCalendarEvents: async () => B_EVENTS,
    batchDeleteCalendarEvents: async (ids: string[]) => { deleted.push(ids); },
    updateCalendarEvent: async () => {},
    deleteCalendar: async (id: string) => { destroyedCalendars.push(id); },
  };
  return { client, deleted, destroyedCalendars };
}

// Account B's own "Work" calendar has raw id "b"; two personal events live in it.
const B_EVENTS = [
  { id: 'e1', uid: 'b-dentist', title: 'Dentist', calendarIds: { b: true }, start: '2026-10-01T09:00:00' },
  { id: 'e2', uid: 'b-review', title: 'Perf review', calendarIds: { b: true }, start: '2026-10-02T09:00:00' },
];
const B = () => fakeClient('https://mail-b.example', 'bob@b.example', 'c', [{ id: 'b', name: 'Work' }]);

function subscribe(sub: Record<string, unknown>) {
  useCalendarStore.setState({
    icalSubscriptions: [{ id: 's1', url: 'https://feeds.example/holidays.ics', calendarId: 'b', name: 'Holidays', color: '#f00', refreshInterval: 60, lastRefreshed: null, ...sub }] as never,
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 })));
  useCalendarStore.setState({ importEvents: vi.fn(async () => {}) as never, dateRange: null });
});

describe('iCal subscriptions stay with the login that made them', () => {
  it('an untagged subscription from another account does not wipe events on refresh', async () => {
    subscribe({});
    const { client, deleted } = B();
    await useCalendarStore.getState().refreshAllSubscriptions(client as never);
    expect(deleted).toEqual([]);
  });

  it('a subscription tagged with the same JMAP account id on another server is left alone', async () => {
    subscribe({ accountId: 'c', owner: 'https://mail-a.example|alice@a.example' });
    const { client, deleted } = B();
    await useCalendarStore.getState().refreshAllSubscriptions(client as never);
    expect(deleted).toEqual([]);
  });

  it('removing an unowned subscription does not destroy the calendar with its id', async () => {
    subscribe({});
    const { client, destroyedCalendars } = B();
    await useCalendarStore.getState().removeICalSubscription(client as never, 's1');
    expect(destroyedCalendars).toEqual([]);
    expect(useCalendarStore.getState().icalSubscriptions).toEqual([]);
  });

  it('adopts an untagged subscription whose calendar id and name are in this account', async () => {
    subscribe({});
    const { client } = fakeClient('https://mail-b.example', 'bob@b.example', 'c', [{ id: 'b', name: 'Holidays' }]);
    await useCalendarStore.getState().refreshICalSubscription(client as never, 's1');
    expect(useCalendarStore.getState().icalSubscriptions[0].owner).toBe(subscriptionOwner(client));
    expect(useCalendarStore.getState().icalSubscriptions[0].lastRefreshed).not.toBeNull();
  });

  it('forgets a signed-out login\'s subscriptions and keeps the others', () => {
    useCalendarStore.setState({
      icalSubscriptions: [
        { id: 's1', owner: 'https://mail-a.example|alice@a.example', url: 'https://calendar.example/private-SECRET/basic.ics' },
        { id: 's2', owner: 'https://mail-b.example|bob@b.example', url: 'https://feeds.example/b.ics' },
      ] as never,
    });
    useCalendarStore.getState().forgetICalSubscriptions('https://mail-a.example|alice@a.example');
    expect(useCalendarStore.getState().icalSubscriptions.map((s) => s.id)).toEqual(['s2']);
    useCalendarStore.getState().clearICalSubscriptions();
    expect(window.localStorage.getItem('calendar-storage')).not.toContain('private-SECRET');
  });
});
