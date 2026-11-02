import { beforeEach, describe, expect, it, vi } from 'vitest';

const lite = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/lite', async (original) => ({
  ...(await original<typeof import('@/lib/lite')>()),
  get IS_LITE() { return lite.value; },
}));
const apiFetch = vi.fn();
vi.mock('@/lib/browser-navigation', async (original) => ({
  ...(await original<typeof import('@/lib/browser-navigation')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('@/lib/auth/active-account-slot', () => ({ getActiveAccountSlotHeaders: () => ({ 'X-JMAP-Cookie-Slot': '1' }) }));

import {
  companyCalendarId, createCompanyCalendar, isCompanyCalendarId, loadFeedEvents, resetCompanyCalendarMemory, toCompanyEvents,
} from '../company-calendars';
import { purgeSignedOutData, runBeforeSignOut } from '../sign-out-cleanup';
import { useAccountStore } from '@/stores/account-store';
import type { CompanyFeed } from '@/lib/admin/organisation-policy';
import type { CalendarEvent } from '@/lib/jmap/types';

const FEED: CompanyFeed = { id: 'hol', name: 'Holidays', url: '', urlHeld: true, color: '#16a34a', refreshMinutes: 60 };
const ICS = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const PARSED = [{ uid: '1', title: 'Closed', start: '2026-12-24T00:00:00', duration: 'P1D', showWithoutTime: true }];

function fakeClient() {
  return {
    getCalendarsAccountId: () => 'alice',
    uploadBlob: vi.fn(async () => ({ blobId: 'blob1', size: 1, type: 'text/calendar' })),
    parseCalendarEvents: vi.fn(async () => PARSED as Partial<CalendarEvent>[]),
  };
}

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-02T08:00:00Z');

beforeEach(() => {
  resetCompanyCalendarMemory();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => new Response(ICS));
  lite.value = false;
  // No IndexedDB in jsdom: memory only.
});

describe('loadFeedEvents', () => {
  it('fetches the feed by id through the server, uploads it on the XHR path and parses it', async () => {
    const client = fakeClient();
    expect(await loadFeedEvents(client, 'alice', FEED, T0)).toEqual(PARSED);
    expect(apiFetch).toHaveBeenCalledWith('/api/fetch-ical', expect.objectContaining({ method: 'POST', body: JSON.stringify({ feedId: 'hol' }) }));
    // The server resolves the feed for the active account's sign-in slot.
    expect(apiFetch.mock.calls[0][1].headers).toMatchObject({ 'X-JMAP-Cookie-Slot': '1' });
    const [, options] = client.uploadBlob.mock.calls[0] as unknown as [File, { accountId: string; onProgress?: unknown }];
    expect(options.accountId).toBe('alice');
    expect(typeof options.onProgress).toBe('function');
    expect(client.parseCalendarEvents).toHaveBeenCalledWith('alice', 'blob1');
  });

  it('asks again only after the refresh interval, and uploads only a feed that changed', async () => {
    const client = fakeClient();
    await loadFeedEvents(client, 'alice', FEED, T0);
    await loadFeedEvents(client, 'alice', FEED, T0 + 30 * 60_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await loadFeedEvents(client, 'alice', FEED, T0 + HOUR + 1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(client.uploadBlob).toHaveBeenCalledTimes(1);

    apiFetch.mockImplementation(async () => new Response(ICS.replace('UID:1', 'UID:2')));
    await loadFeedEvents(client, 'alice', FEED, T0 + 2 * HOUR + 2);
    expect(client.uploadBlob).toHaveBeenCalledTimes(2);
  });

  it('keeps the last events when the feed can\'t be fetched', async () => {
    const client = fakeClient();
    await loadFeedEvents(client, 'alice', FEED, T0);
    apiFetch.mockImplementation(async () => new Response('down', { status: 502 }));
    expect(await loadFeedEvents(client, 'alice', FEED, T0 + 2 * HOUR)).toEqual(PARSED);
    expect(await loadFeedEvents(fakeClient(), 'bob', FEED, T0)).toEqual([]);
  });

  it('fetches the address itself in Lite, where there is no server', async () => {
    lite.value = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(ICS));
    try {
      await loadFeedEvents(fakeClient(), 'alice', { ...FEED, url: 'https://cal.example.org/h.ics', urlHeld: undefined }, T0);
      expect(fetchMock).toHaveBeenCalledWith('https://cal.example.org/h.ics', expect.objectContaining({ credentials: 'omit' }));
      expect(apiFetch).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('forgets every feed on a full sign-out', async () => {
    const client = fakeClient();
    await loadFeedEvents(client, 'alice', FEED, T0);
    purgeSignedOutData();
    await loadFeedEvents(client, 'alice', FEED, T0 + 60_000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('the company calendar and its events', () => {
  it('is read-only and out of free/busy', () => {
    const calendar = createCompanyCalendar(FEED);
    expect(calendar).toMatchObject({ id: '__company-calendar__:hol', name: 'Holidays', color: '#16a34a', isCompany: true, includeInAvailability: 'none' });
    expect(Object.values(calendar.myRights).filter(Boolean)).toEqual([true, true]); // read free/busy and items only
    expect(isCompanyCalendarId(calendar.id)).toBe(true);
    expect(isCompanyCalendarId('b')).toBe(false);
  });

  it('turns parsed events into events of the calendar, with nothing to answer', () => {
    const events = toCompanyEvents('hol', [
      { ...PARSED[0], participants: { a: { email: 'x@example.org' } } as never, organizerCalendarAddress: 'mailto:x@example.org' },
      { uid: 'no-start', title: 'Broken' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ calendarIds: { [companyCalendarId('hol')]: true }, participants: null, organizerCalendarAddress: null, title: 'Closed' });
  });
});

describe('when a feed goes away or the user signs out', () => {
  it('drops the events of a feed the server no longer gives the user, and keeps them through an outage', async () => {
    const client = fakeClient();
    await loadFeedEvents(client, 'alice|a', FEED, T0);
    apiFetch.mockImplementation(async () => new Response('down', { status: 503 }));
    expect(await loadFeedEvents(client, 'alice|a', FEED, T0 + 2 * HOUR)).toEqual(PARSED);
    apiFetch.mockImplementation(async () => new Response('{"error":"Unknown calendar"}', { status: 404 }));
    expect(await loadFeedEvents(client, 'alice|a', FEED, T0 + 3 * HOUR)).toEqual([]);
    // Nothing kept: the next look asks the server again.
    await loadFeedEvents(client, 'alice|a', FEED, T0 + 3 * HOUR + 1);
    expect(apiFetch).toHaveBeenCalledTimes(4);
  });

  it('forgets one login\'s feeds when that account signs out', async () => {
    const client = fakeClient();
    await loadFeedEvents(client, 'alice@example.org|a', FEED, T0);
    await loadFeedEvents(client, 'bob@example.org|b', FEED, T0);
    useAccountStore.setState({ accounts: [{ id: 'acc-alice', username: 'alice@example.org' }] as never });
    await runBeforeSignOut('acc-alice');
    await loadFeedEvents(client, 'alice@example.org|a', FEED, T0 + 60_000);
    await loadFeedEvents(client, 'bob@example.org|b', FEED, T0 + 60_000);
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });
});
