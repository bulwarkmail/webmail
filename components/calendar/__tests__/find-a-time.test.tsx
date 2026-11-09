import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FindATime, suggestTimes, visibleCalendarOwners } from '../find-a-time';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { BusyPeriod, Calendar, Principal, PrincipalListing } from '@/lib/jmap/types';

vi.mock('../free-busy-share-button', () => ({ FreeBusyShareButton: () => createElement('div', { 'data-testid': 'share-button' }) }));

const HOUR = 3600_000;
// Monday 2 November 2026, 07:00 in Berlin.
const NOW = new Date('2026-11-02T06:00:00Z');

const DIRECTORY: Principal[] = [
  { id: 'me', type: 'individual', name: 'me', email: 'me@example.org' },
  { id: 'bob', type: 'individual', name: 'bob', email: 'bob@example.org' },
  { id: 'carol', type: 'individual', name: 'carol', email: 'carol@example.org' },
];

function fakeClient(options: {
  listing?: PrincipalListing;
  periods?: Record<string, BusyPeriod[]>;
  errors?: Record<string, string>;
}) {
  const calls: string[][] = [];
  const client = {
    getUsername: () => 'me@example.org',
    getAccountId: () => 'me',
    supportsAvailability: () => true,
    mayGetAvailability: async () => true,
    listPrincipals: async () => options.listing ?? { principals: DIRECTORY, status: 'ok' },
    getPrincipals: async () => DIRECTORY,
    getPrincipalsAvailability: async (ids: string[]) => {
      calls.push(ids);
      return Object.fromEntries(ids.map((id) => [id, options.errors?.[id] ? { error: options.errors[id] } : { periods: options.periods?.[id] ?? [] }]));
    },
  };
  return { client: client as unknown as IJMAPClient, calls };
}

const busy = (utcStart: string, utcEnd: string): BusyPeriod => ({ utcStart, utcEnd, busyStatus: 'confirmed' });
const input = (attendees: Array<{ name: string; email: string }>, visible: string[] = []) => ({
  attendees,
  durationMs: HOUR,
  now: NOW,
  timeZone: 'Europe/Berlin',
  workingDays: [1, 2, 3, 4, 5],
  dayStartHour: 9,
  dayEndHour: 17,
  visibleOwners: new Set(visible),
});

describe('suggestTimes', () => {
  it('proposes the first slot free for everyone, the organiser included', async () => {
    const { client, calls } = fakeClient({
      periods: {
        me: [busy('2026-11-02T08:00:00Z', '2026-11-02T08:30:00Z')], // me 9:00-9:30
        bob: [busy('2026-11-02T08:30:00Z', '2026-11-02T10:00:00Z')], // bob 9:30-11
        carol: [busy('2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z')], // carol 11-12
      },
    });
    const outcome = await suggestTimes(client, input([
      { name: 'Bob', email: 'bob@example.org' },
      { name: 'Carol', email: 'Carol@example.org' },
    ]));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.slots[0].start.toISOString()).toBe('2026-11-02T11:00:00.000Z'); // 12:00 Berlin
    expect(outcome.result.notChecked).toEqual([]);
    // One call per person over the whole window, in one batch.
    expect(calls).toEqual([['me', 'bob', 'carol']]);
  });

  it('never counts an attendee without busy time as free unless their calendar is visible', async () => {
    const { client } = fakeClient({ periods: { bob: [busy('2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z')] } });
    const hidden = await suggestTimes(client, input([{ name: 'Bob', email: 'bob@example.org' }, { name: 'Carol', email: 'carol@example.org' }]));
    expect(hidden.kind === 'ok' && hidden.result.notChecked).toEqual([{ email: 'carol@example.org', name: 'Carol', reason: 'unknown' }]);
    const visible = await suggestTimes(client, input([{ name: 'Carol', email: 'carol@example.org' }], ['carol@example.org']));
    expect(visible.kind === 'ok' && visible.result.notChecked).toEqual([]);
  });

  it('names attendees outside the organisation and leaves them out', async () => {
    const { client, calls } = fakeClient({});
    const outcome = await suggestTimes(client, input([{ name: '', email: 'x@outside.com' }]));
    expect(outcome.kind === 'ok' && outcome.result.notChecked).toEqual([{ email: 'x@outside.com', name: '', reason: 'external' }]);
    expect(calls).toEqual([['me']]);
  });

  it('says directory queries are off when the server refused the listing, and still checks the people it knows', async () => {
    // Stalwart 1.0.1 with directory queries off: Principal/query refused,
    // the principals the user shares an account with still known.
    const { client, calls } = fakeClient({
      listing: { principals: [DIRECTORY[0], DIRECTORY[1]], status: 'restricted', directoryQueriesOff: true },
      periods: { bob: [busy('2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z')] },
    });
    const outcome = await suggestTimes(client, input([{ name: 'Bob', email: 'bob@example.org' }, { name: 'Carol', email: 'carol@example.org' }]));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.directoryQueriesOff).toBe(true);
    expect(outcome.result.notChecked).toEqual([{ email: 'carol@example.org', name: 'Carol', reason: 'not_found' }]);
    expect(outcome.result.slots[0].start.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(calls).toEqual([['me', 'bob']]);
  });

  it('does not let the edited event hide its own time', async () => {
    // The meeting being moved sits at 9:00-10:00 Berlin in everyone's calendar.
    const { client } = fakeClient({ periods: { bob: [busy('2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z')] } });
    const ownWindow = { start: new Date('2026-11-02T08:00:00Z'), end: new Date('2026-11-02T09:00:00Z') };
    const outcome = await suggestTimes(client, { ...input([{ name: 'Bob', email: 'bob@example.org' }]), ownWindow });
    expect(outcome.kind === 'ok' && outcome.result.slots[0].start.toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('says a lookup failed, and stops on forbidden', async () => {
    const failed = await suggestTimes(fakeClient({ errors: { bob: 'serverUnavailable' } }).client, input([{ name: 'Bob', email: 'bob@example.org' }]));
    expect(failed.kind === 'ok' && failed.result.notChecked).toEqual([{ email: 'bob@example.org', name: 'Bob', reason: 'error' }]);
    const refused = await suggestTimes(fakeClient({ errors: { me: 'forbidden', bob: 'forbidden' } }).client, input([{ name: 'Bob', email: 'bob@example.org' }]));
    expect(refused.kind).toBe('unavailable');
  });

  it('refuses a search that would go over the 100 calls a minute without asking', async () => {
    const { client, calls } = fakeClient({});
    const many: Principal[] = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, type: 'individual' as const, name: `p${i}`, email: `p${i}@example.org` }));
    const listing = { principals: [...DIRECTORY, ...many], status: 'ok' as const };
    Object.assign(client, { listPrincipals: async () => listing });
    const outcome = await suggestTimes(client, input(many.map((p) => ({ name: '', email: p.email! }))));
    expect(outcome.kind).toBe('rate_limited');
    expect(calls).toEqual([]);
  });

  it('counts the calls of earlier searches against the minute', async () => {
    const { client, calls } = fakeClient({});
    const people: Principal[] = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, type: 'individual' as const, name: `q${i}`, email: `q${i}@example.org` }));
    Object.assign(client, { listPrincipals: async () => ({ principals: [...DIRECTORY, ...people], status: 'ok' }) });
    const first = await suggestTimes(client, input(people.map((p) => ({ name: '', email: p.email! }))));
    expect(first.kind).toBe('ok');
    // A different window, so nothing comes from the cache: 61 more would make 122.
    const second = await suggestTimes(client, { ...input(people.map((p) => ({ name: '', email: p.email! }))), now: new Date('2026-11-03T06:00:00Z') });
    expect(second.kind).toBe('rate_limited');
    expect(calls).toHaveLength(1);
  });
});

describe('visibleCalendarOwners', () => {
  it('lists the owners of shared calendars the user may read', () => {
    const calendars = [
      { isShared: true, accountName: 'Bob@example.org', myRights: { mayReadItems: true } },
      { isShared: true, accountName: 'carol@example.org', myRights: { mayReadItems: false } },
      { isShared: false, accountName: 'me@example.org', myRights: { mayReadItems: true } },
    ] as unknown as Calendar[];
    expect([...visibleCalendarOwners(calendars)]).toEqual(['bob@example.org']);
  });
});

describe('FindATime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    useSettingsStore.setState({ timeZone: 'Europe/Berlin', calendarWorkingDays: [1, 2, 3, 4, 5], calendarDayStartHour: 9, calendarDayEndHour: 17, timeFormat: '24h' });
    useCalendarStore.setState({ calendars: [] } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ client: null } as never);
    useSettingsStore.setState({ timeZone: 'auto' });
  });

  it('lists slots, moves the event to the one picked, and closes on Escape with the focus back on the button', async () => {
    const { client } = fakeClient({ periods: { bob: [busy('2026-11-02T08:00:00Z', '2026-11-02T10:00:00Z')] } });
    useAuthStore.setState({ client } as never);
    const onPick = vi.fn();
    render(createElement(FindATime, {
      attendees: [{ name: 'Bob', email: 'bob@example.org' }],
      start: new Date('2026-11-05T09:00:00Z'),
      end: new Date('2026-11-05T09:30:00Z'),
      onPick,
    }));
    const button = screen.getByTestId('find-a-time-button');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const list = await screen.findByTestId('find-a-time-slots');
    const slots = list.querySelectorAll('button');
    expect(slots).toHaveLength(5);
    // The first half hour after Bob's 9-11 (Berlin).
    expect(slots[0].getAttribute('data-slot-start')).toBe('2026-11-02T10:00:00.000Z');
    fireEvent.click(slots[0]);
    expect(onPick).toHaveBeenCalledWith({ start: new Date('2026-11-02T10:00:00Z'), end: new Date('2026-11-02T10:30:00Z') });
    // Bob was checked; nothing is listed as not checked.
    expect(screen.queryByTestId('find-a-time-not-checked')).toBeNull();

    fireEvent.keyDown(screen.getByTestId('find-a-time-panel'), { key: 'Escape' });
    expect(screen.queryByTestId('find-a-time-panel')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('says how many times it found, and Escape on the button closes the list without reaching the editor', async () => {
    const { client } = fakeClient({});
    useAuthStore.setState({ client } as never);
    const editorKeys = vi.fn();
    render(createElement('div', { onKeyDown: (e: { key: string }) => editorKeys(e.key) }, createElement(FindATime, {
      attendees: [{ name: 'Bob', email: 'bob@example.org' }],
      start: new Date('2026-11-05T09:00:00Z'),
      end: new Date('2026-11-05T09:30:00Z'),
      onPick: vi.fn(),
    })));
    const button = screen.getByTestId('find-a-time-button');
    fireEvent.click(button);
    await screen.findByTestId('find-a-time-slots');
    expect(screen.getByTestId('find-a-time-panel').querySelector('[role="status"]')).toHaveTextContent('found');
    button.focus();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByTestId('find-a-time-panel')).toBeNull();
    expect(editorKeys).not.toHaveBeenCalled();
  });

  it('names the people it could not check and offers to share free/busy', async () => {
    const { client } = fakeClient({});
    useAuthStore.setState({ client } as never);
    render(createElement(FindATime, {
      attendees: [{ name: 'Carol', email: 'carol@example.org' }, { name: '', email: 'x@outside.com' }],
      start: new Date('2026-11-05T09:00:00Z'),
      end: new Date('2026-11-05T10:00:00Z'),
      onPick: vi.fn(),
    }));
    fireEvent.click(screen.getByTestId('find-a-time-button'));
    const note = await screen.findByTestId('find-a-time-not-checked');
    expect(note).toHaveTextContent('not_checked_item');
    expect(note).toHaveTextContent('unknown_note');
    expect(screen.getByTestId('share-button')).toBeInTheDocument();
  });

  it('shows nothing without attendees', () => {
    const { client } = fakeClient({});
    useAuthStore.setState({ client } as never);
    const { container } = render(createElement(FindATime, { attendees: [], start: NOW, end: new Date(NOW.getTime() + HOUR), onPick: vi.fn() }));
    expect(container).toBeEmptyDOMElement();
  });
});
