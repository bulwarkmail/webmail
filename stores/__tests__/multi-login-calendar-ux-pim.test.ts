import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from '../task-store';
import { useCalendarStore, resolveMutationTarget } from '../calendar-store';
import { setClientLookup } from '../client-registry';
import { eventUserEmails } from '@/hooks/use-event-user-emails';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// pim-12: with two signed-in logins the calendar shows both logins'
// calendars, and a change to an item of the other login goes through that
// login's client into its account.

function task(id: string, calendarId: string): CalendarTask {
  return {
    id, calendarIds: { [calendarId]: true }, '@type': 'Task', uid: id, title: id, description: '',
    due: null, start: null, duration: null, timeZone: null, showWithoutTime: true, progress: 'needs-action',
    priority: 0, privacy: 'public', keywords: null, categories: null, color: null, created: null,
    updated: '2026-11-01T00:00:00Z', recurrenceRules: null, alerts: null, relatedTo: null,
  } as CalendarTask;
}

function fakeClient(name: string, tasks: CalendarTask[], calendars: Partial<Calendar>[] = []) {
  return {
    name,
    getCalendarTasks: vi.fn().mockResolvedValue(tasks),
    createCalendarTask: vi.fn().mockImplementation(async (t: Partial<CalendarTask>) => ({ ...task('new', Object.keys(t.calendarIds ?? {})[0]), ...t, id: 'new' })),
    updateCalendarTask: vi.fn().mockImplementation(async (id: string) => id),
    deleteCalendarTask: vi.fn().mockResolvedValue(undefined),
    getAllCalendarsWithFailures: vi.fn().mockResolvedValue({ calendars, failedAccountIds: [] }),
    getAllCalendars: vi.fn().mockResolvedValue(calendars),
    queryAllCalendarEvents: vi.fn().mockResolvedValue([]),
    getParticipantIdentities: vi.fn().mockResolvedValue([]),
  } as unknown as IJMAPClient & { getCalendarTasks: ReturnType<typeof vi.fn>; createCalendarTask: ReturnType<typeof vi.fn>; updateCalendarTask: ReturnType<typeof vi.fn>; deleteCalendarTask: ReturnType<typeof vi.fn> };
}

describe('tasks of several logins (pim-12)', () => {
  const a = fakeClient('a', [task('t1', 'e')]);
  const b = fakeClient('b', [task('t9', 'b1')]);

  beforeEach(() => {
    vi.clearAllMocks();
    setClientLookup((id) => (id === 'login-a' ? a : id === 'login-b' ? b : undefined));
    useTaskStore.setState({ tasks: [], accountClients: null } as never);
    useTaskStore.getState().setAccountClients([{ localAccountId: 'login-a', client: a }, { localAccountId: 'login-b', client: b }]);
  });

  it('lists both logins\' tasks with their calendars named like the calendar store names them', async () => {
    await useTaskStore.getState().fetchTasks(a);
    const tasks = useTaskStore.getState().tasks;
    expect(tasks.map((t) => [t.id, Object.keys(t.calendarIds)[0]])).toEqual([
      ['login-a::t1', 'login-a::e'],
      ['login-b::t9', 'login-b::b1'],
    ]);
  });

  it('makes, changes and deletes a task of the other login through that login', async () => {
    await useTaskStore.getState().fetchTasks(a);
    const created = await useTaskStore.getState().createTask(a, { title: 'x', calendarIds: { 'login-b::b1': true } });
    expect(b.createCalendarTask).toHaveBeenCalledWith(expect.objectContaining({ calendarIds: { b1: true } }));
    expect(a.createCalendarTask).not.toHaveBeenCalled();
    expect(created?.id).toBe('login-b::new');

    await useTaskStore.getState().toggleTaskComplete(a, useTaskStore.getState().tasks.find((t) => t.id === 'login-b::t9')!);
    expect(b.updateCalendarTask).toHaveBeenCalledWith('t9', { progress: 'completed' });

    await useTaskStore.getState().updateTask(a, 'login-b::t9', { title: 'renamed' });
    expect(b.updateCalendarTask).toHaveBeenCalledWith('t9', { title: 'renamed' });

    await useTaskStore.getState().deleteTask(a, 'login-b::t9');
    expect(b.deleteCalendarTask).toHaveBeenCalledWith('t9');
    expect(a.updateCalendarTask).not.toHaveBeenCalled();
    expect(a.deleteCalendarTask).not.toHaveBeenCalled();
  });

  it('moves a task into a list of the other login by making it there and removing it here', async () => {
    await useTaskStore.getState().fetchTasks(a);
    await useTaskStore.getState().updateTask(a, 'login-a::t1', { calendarIds: { 'login-b::b1': true } });
    expect(b.createCalendarTask).toHaveBeenCalledWith(expect.objectContaining({ calendarIds: { b1: true }, title: 't1' }));
    expect(a.deleteCalendarTask).toHaveBeenCalledWith('t1');
  });
});

describe('calendar loads with several logins (pim-12)', () => {
  it('loads every login when a caller names one client, and a slower one-login answer does not win', async () => {
    let answerSingle: (v: unknown) => void = () => {};
    const a = fakeClient('a', [], [{ id: 'c', name: 'Work' }]);
    (a.getAllCalendarsWithFailures as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((resolve) => { answerSingle = resolve; }));
    const b = fakeClient('b', [], [{ id: 'c', name: 'Ben' }]);
    useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], knownCalendarIds: null, accountClients: null } as never);

    // A one-login load starts first (the page), then the logins are known.
    const single = useCalendarStore.getState().fetchCalendars(a);
    useCalendarStore.getState().setAccountClients([{ localAccountId: 'login-a', client: a }, { localAccountId: 'login-b', client: b }], 'login-a');
    await useCalendarStore.getState().fetchCalendars(a);
    answerSingle({ calendars: [{ id: 'c', name: 'Work' }], failedAccountIds: [] });
    await single;

    const ids = useCalendarStore.getState().calendars.map((c) => c.id).sort();
    expect(ids).toEqual(['login-a::c', 'login-b::c']);
    // The other login's calendars start ticked.
    expect(useCalendarStore.getState().selectedCalendarIds.sort()).toEqual(['login-a::c', 'login-b::c']);
  });
});

describe('a calendar shared between two signed-in logins (pim-12)', () => {
  it('shows once, under the login that owns it', async () => {
    const a = fakeClient('a', [], [
      { id: 'c', name: 'Work', accountId: 'ea', accountName: 'a@example.org', originalId: 'c' },
      { id: 'eb:b1', name: 'Team', accountId: 'eb', accountName: 'b@example.org', originalId: 'b1', isShared: true },
    ]);
    const b = fakeClient('b', [], [{ id: 'b1', name: 'Team', accountId: 'eb', accountName: 'b@example.org', originalId: 'b1' }]);
    useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], knownCalendarIds: null, accountClients: null } as never);
    await useCalendarStore.getState().fetchAllAccountsCalendars([{ localAccountId: 'login-a', client: a }, { localAccountId: 'login-b', client: b }], 'login-a');
    expect(useCalendarStore.getState().calendars.map((c) => c.id).sort()).toEqual(['login-a::c', 'login-b::b1']);
  });
});

// #1676: a group's calendar both logins are members of was listed once per
// login, and each of its events showed twice.
describe("a group's calendar two signed-in logins are members of (#1676)", () => {
  const groupCal = { id: 'g:c1', name: 'Team', accountId: 'g', accountName: 'info@example.org', originalId: 'c1', isShared: true };
  const groupEvent = (id: string) => ({ id: `g:${id}`, originalId: id, uid: id, title: 'Stand-up', calendarIds: { 'g:c1': true }, start: '2026-11-04T10:00:00', duration: 'PT1H' });
  const withServer = (client: IJMAPClient, url: string) => Object.assign(client, { getServerUrl: () => url });

  beforeEach(() => {
    useCalendarStore.setState({ calendars: [], events: [], selectedCalendarIds: [], knownCalendarIds: null, accountClients: null } as never);
  });

  it('shows it once, under the first login, with its events once', async () => {
    const a = withServer(fakeClient('a', [], [{ id: 'c', name: 'A home', accountId: 'ea', originalId: 'c' }, groupCal]), 'https://mail.example.org');
    const b = withServer(fakeClient('b', [], [{ id: 'c', name: 'B home', accountId: 'eb', originalId: 'c' }, groupCal]), 'https://mail.example.org/');
    (a.queryAllCalendarEvents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([groupEvent('e1')]);
    (b.queryAllCalendarEvents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([groupEvent('e1')]);
    const accounts = [{ localAccountId: 'login-a', client: a }, { localAccountId: 'login-b', client: b }];

    await useCalendarStore.getState().fetchAllAccountsCalendars(accounts, 'login-b');
    expect(useCalendarStore.getState().calendars.map((c) => c.id).sort()).toEqual(['login-a::c', 'login-a::g:c1', 'login-b::c']);

    await useCalendarStore.getState().fetchAllAccountsEvents(accounts, '2026-11-01T00:00:00', '2026-11-30T23:59:59');
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual(['login-a::g:e1']);
  });

  it('drops events already loaded under the other login once the calendars load', async () => {
    const a = fakeClient('a', [], [groupCal]);
    const b = fakeClient('b', [], [groupCal]);
    useCalendarStore.setState({
      events: [
        { id: 'login-a::g:e1', calendarIds: { 'login-a::g:c1': true }, localAccountId: 'login-a' },
        { id: 'login-b::g:e1', calendarIds: { 'login-b::g:c1': true }, localAccountId: 'login-b' },
      ],
    } as never);
    await useCalendarStore.getState().fetchAllAccountsCalendars([{ localAccountId: 'login-a', client: a }, { localAccountId: 'login-b', client: b }], 'login-a');
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual(['login-a::g:e1']);
  });

  it('keeps a group on another server that has the same ids', async () => {
    const a = withServer(fakeClient('a', [], [groupCal]), 'https://one.example.org');
    const b = withServer(fakeClient('b', [], [groupCal]), 'https://two.example.org');
    await useCalendarStore.getState().fetchAllAccountsCalendars([{ localAccountId: 'login-a', client: a }, { localAccountId: 'login-b', client: b }], 'login-a');
    expect(useCalendarStore.getState().calendars.map((c) => c.id).sort()).toEqual(['login-a::g:c1', 'login-b::g:c1']);
  });
});

describe("an event made in the other login's calendar (pim-12)", () => {
  it("goes through that login and is kept as that login's, though both logins use the same raw ids", async () => {
    const a = fakeClient('a', []);
    const created = { id: 'p', uid: 'u1', title: 'New', calendarIds: { b: true }, start: '2026-11-04T10:00:00', duration: 'PT1H' };
    const b = { ...fakeClient('b', []), createCalendarEvent: vi.fn().mockResolvedValue(created) } as unknown as IJMAPClient & { createCalendarEvent: ReturnType<typeof vi.fn> };
    (a as unknown as { createCalendarEvent: unknown }).createCalendarEvent = vi.fn();
    setClientLookup((id) => (id === 'login-a' ? a : id === 'login-b' ? b : undefined));
    useCalendarStore.setState({
      calendars: [
        { id: 'login-a::b', originalId: 'b', name: 'A home', localAccountId: 'login-a', accountId: 'ea' },
        { id: 'login-b::b', originalId: 'b', name: 'B home', localAccountId: 'login-b', accountId: 'eb' },
      ],
      events: [{ id: 'login-a::p', originalId: 'p', title: 'Night train', calendarIds: { 'login-a::b': true }, localAccountId: 'login-a', start: '2026-11-06T22:30:00' }],
      selectedCalendarIds: ['login-a::b', 'login-b::b'],
      dateRange: null,
    } as never);
    const made = await useCalendarStore.getState().createEvent(a, { title: 'New', calendarIds: { 'login-b::b': true }, start: '2026-11-04T10:00:00' });
    expect(b.createCalendarEvent).toHaveBeenCalled();
    expect(made?.id).toBe('login-b::p');
    expect(made?.calendarIds).toEqual({ 'login-b::b': true });
  });
});

describe('a change to an event the store no longer holds (pim-12)', () => {
  it('still goes to the login its id names, with the raw id', () => {
    expect(resolveMutationTarget([], 'login-b::h1pu2', 'occurrence')).toEqual({ realId: 'h1pu2', localAccountId: 'login-b', isOccurrence: false });
    expect(resolveMutationTarget([], 'login-b::ev:x9', 'series')).toEqual({ realId: 'x9', targetAccountId: 'ev', localAccountId: 'login-b', isOccurrence: false });
    expect(resolveMutationTarget([], 'plain', 'series')).toEqual({ realId: 'plain', isOccurrence: false });
  });
});

describe('answering as the event\'s own login (pim-12)', () => {
  const accounts = [{ id: 'login-a', email: 'a@example.org' }, { id: 'login-b', email: 'b@example.org' }];

  it('uses the other login\'s address for its events and the active one\'s otherwise', () => {
    expect(eventUserEmails({ localAccountId: 'login-b' }, ['a@example.org'], 'login-a', accounts)).toEqual(['b@example.org']);
    expect(eventUserEmails({ localAccountId: 'login-a' }, ['a@example.org', 'alias@example.org'], 'login-a', accounts)).toEqual(['a@example.org', 'alias@example.org']);
    expect(eventUserEmails({}, ['a@example.org'], 'login-a', accounts)).toEqual(['a@example.org']);
  });
});
