import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import { taskListsOf } from '@/components/calendar/task-list-view';
import { taskTargets } from '@/lib/calendar-targets';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

// #1595: the server doesn't say which components a calendar takes, so an
// empty calendar made for tasks was neither a task list nor offered for a
// task. The kind picked when it is made here is remembered instead.

const RIGHTS = { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayDelete: true, mayShare: true };

function cal(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'c', name: 'Cal', color: null, sortOrder: 0, isSubscribed: true, isVisible: true,
    isDefault: false, includeInAvailability: 'all', timeZone: null, shareWith: null,
    myRights: RIGHTS, isShared: false,
    ...overrides,
  } as unknown as Calendar;
}

function clientFor(username: string, listed: () => Calendar[], created?: Calendar) {
  return {
    getServerUrl: () => 'https://mail.example.org',
    getUsername: () => username,
    getAccountId: () => 'acc',
    getCalendarsAccountId: () => 'acc',
    createCalendar: vi.fn(async () => created),
    getAllCalendarsWithFailures: vi.fn(async () => ({ calendars: listed(), failedAccountIds: [] })),
    getCalendarParticipantIdentities: vi.fn(async () => []),
  } as unknown as IJMAPClient;
}

const state = () => useCalendarStore.getState();
const byId = (id: string) => state().calendars.find((c) => c.id === id);

beforeEach(() => {
  useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], taskCalendarKinds: {}, accountClients: null, error: null });
});

describe('a calendar made to hold tasks', () => {
  it('is a task list and a place for a task while it is still empty', async () => {
    const work = cal({ id: 'w', name: 'Work', isDefault: true });
    useCalendarStore.setState({ calendars: [work], selectedCalendarIds: ['w'] });
    const client = clientFor('me@example.org', () => [work], cal({ id: 'p', name: 'Projects' }));

    await state().createCalendar(client, { name: 'Projects' }, { components: ['VEVENT', 'VTODO'] });

    expect(taskListsOf(state().calendars, []).map((c) => c.name)).toEqual(['Projects']);
    expect(taskTargets(state().calendars).map((c) => c.name)).toEqual(['Projects']);
    // It takes events as well, so it stays on the grid.
    expect(byId('p')?.isTasksOnly).toBeFalsy();
    expect(state().selectedCalendarIds).toEqual(['w', 'p']);
  });

  it('stays off the grid when it was made for tasks alone', async () => {
    const client = clientFor('me@example.org', () => [], cal({ id: 't', name: 'To-do' }));

    await state().createCalendar(client, { name: 'To-do' }, { components: ['VTODO'] });

    expect(byId('t')?.isTasksOnly).toBe(true);
    expect(state().selectedCalendarIds).toEqual([]);
    expect(taskListsOf(state().calendars, []).map((c) => c.name)).toEqual(['To-do']);
  });

  it('is still one after the calendars are loaded again, where the server reports nothing', async () => {
    const listed = [cal({ id: 'w', name: 'Work', isDefault: true })];
    const client = clientFor('me@example.org', () => listed, cal({ id: 'p', name: 'Projects' }));
    await state().createCalendar(client, { name: 'Projects' }, { components: ['VEVENT', 'VTODO'] });
    const todo = clientFor('me@example.org', () => listed, cal({ id: 't', name: 'To-do' }));
    await state().createCalendar(todo, { name: 'To-do' }, { components: ['VTODO'] });

    // As Calendar/get returns them: no word on what they take.
    listed.push(cal({ id: 'p', name: 'Projects' }), cal({ id: 't', name: 'To-do', isTasksOnly: false }));
    await state().fetchCalendars(client);

    expect(taskListsOf(state().calendars, []).map((c) => c.name).sort()).toEqual(['Projects', 'To-do']);
    expect(byId('t')?.isTasksOnly).toBe(true);
    expect(byId('w')?.takesTasks).toBeFalsy();
    // The default selection leaves the task-only one out.
    expect(state().selectedCalendarIds).not.toContain('t');
  });

  it('keeps a calendar for events and tasks on the grid while it holds only tasks', async () => {
    const listed: Calendar[] = [];
    const client = clientFor('me@example.org', () => listed, cal({ id: 'p', name: 'Projects' }));
    await state().createCalendar(client, { name: 'Projects' }, { components: ['VEVENT', 'VTODO'] });

    // What the client works out from the contents once a task is all there is.
    listed.push(cal({ id: 'p', name: 'Projects', isTasksOnly: true }));
    await state().fetchCalendars(client);

    expect(byId('p')?.isTasksOnly).toBe(false);
    expect(state().selectedCalendarIds).toContain('p');
  });

  it('leaves an events calendar as it was', async () => {
    const client = clientFor('me@example.org', () => [], cal({ id: 'e', name: 'Events' }));

    await state().createCalendar(client, { name: 'Events' }, { components: ['VEVENT'] });

    expect(state().taskCalendarKinds).toEqual({});
    expect(taskListsOf(state().calendars, [])).toEqual([]);
  });

  it('does not mark another login\'s calendar that happens to have the same id', async () => {
    const mine = clientFor('me@example.org', () => [], cal({ id: 'p', name: 'Projects' }));
    await state().createCalendar(mine, { name: 'Projects' }, { components: ['VEVENT', 'VTODO'] });

    const other = clientFor('other@example.org', () => [cal({ id: 'p', name: 'Private' })]);
    await state().fetchCalendars(other);

    expect(byId('p')?.takesTasks).toBeFalsy();
    // The first login was not listed, so its mark is kept.
    expect(Object.keys(state().taskCalendarKinds)).toHaveLength(1);
  });

  it('forgets a calendar that is gone, so a new one with its id starts unmarked', async () => {
    const listed: Calendar[] = [];
    const client = clientFor('me@example.org', () => listed, cal({ id: 'p', name: 'Projects' }));
    await state().createCalendar(client, { name: 'Projects' }, { components: ['VEVENT', 'VTODO'] });

    // Deleted elsewhere: the next listing doesn't have it.
    await state().fetchCalendars(client);
    expect(state().taskCalendarKinds).toEqual({});

    listed.push(cal({ id: 'p', name: 'Holidays' }));
    await state().fetchCalendars(client);
    expect(byId('p')?.takesTasks).toBeFalsy();
  });

  it('never marks a shared calendar', async () => {
    const client = clientFor('me@example.org', () => [], cal({ id: 'p', name: 'Projects' }));
    await state().createCalendar(client, { name: 'Projects' }, { components: ['VEVENT', 'VTODO'] });

    const listed = [cal({ id: 'p', name: 'Projects' }), cal({ id: 'team:p', originalId: 'p', accountId: 'team', isShared: true, name: 'Team' })];
    await state().fetchCalendars(clientFor('me@example.org', () => listed));

    expect(byId('p')?.takesTasks).toBe(true);
    expect(byId('team:p')?.takesTasks).toBeFalsy();
  });
});
