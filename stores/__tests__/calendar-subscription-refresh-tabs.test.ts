import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscriptionOwner, useCalendarStore } from '@/stores/calendar-store';
import { noteRefreshed, refreshedInAnyTab } from '@/lib/ical-subscription-refresh';

// #716: subscriptions refresh in every open tab of the app, not only on the
// calendar page. One tab fetches a feed for all: a tab whose own copy of
// lastRefreshed is old leaves a feed another tab just fetched.

const client = {
  getServerUrl: () => 'https://mail.example',
  getUsername: () => 'ann@example.org',
  getAccountId: () => 'a',
  getCalendarsAccountId: () => 'a',
  getCalendars: async () => [{ id: 'cal', name: 'Holidays' }],
  uploadBlob: async () => ({ blobId: 'blob-feed' }),
  parseCalendarEvents: async () => [],
  getCalendarEvents: async () => [],
  batchDeleteCalendarEvents: async () => {},
  updateCalendarEvent: async () => {},
};
const owner = subscriptionOwner(client as never);

const feedFetches = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 })));
  useCalendarStore.setState({
    dateRange: null,
    icalSubscriptions: [{
      id: 's1', url: 'https://feeds.example/holidays.ics', calendarId: 'cal', name: 'Holidays', color: '#f00',
      refreshInterval: 60, lastRefreshed: new Date(Date.now() - 2 * 3_600_000).toISOString(), owner,
    }] as never,
  });
});

describe('iCal subscriptions with several tabs open (#716)', () => {
  it('leaves a feed another tab fetched within its interval', async () => {
    noteRefreshed('s1', Date.now() - 60_000);
    await useCalendarStore.getState().refreshAllSubscriptions(client as never);
    expect(feedFetches()).toBe(0);
  });

  it('fetches a feed that is due, and tells the other tabs', async () => {
    await useCalendarStore.getState().refreshAllSubscriptions(client as never);
    expect(feedFetches()).toBe(1);
    expect(Date.now() - refreshedInAnyTab('s1')).toBeLessThan(5_000);
  });
});
