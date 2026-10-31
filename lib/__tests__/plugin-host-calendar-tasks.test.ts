import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Calendar, CalendarEvent, CalendarEventAlert, CalendarTask } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useTaskStore } from '@/stores/task-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { calendarHooks, taskHooks } from '../plugin-hooks';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'planner', name: 'Planner', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const READ = plugin(['calendar:read', 'tasks:read']);
const WRITE = plugin(['calendar:read', 'calendar:write', 'tasks:read', 'tasks:write']);
const NONE = plugin([]);

const work = { id: 'cal-work', name: 'Work', color: '#f00', isVisible: true, isDefault: true, isTasksOnly: false } as Calendar;
const todo = { id: 'cal-todo', name: 'To do', color: null, isVisible: true, isDefault: false, isTasksOnly: true } as Calendar;

function event(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'e1', uid: 'u1', calendarIds: { 'cal-work': true }, title: 'Standup', description: '',
    start: '2026-05-04T09:00:00', duration: 'PT15M', timeZone: 'Europe/Berlin', showWithoutTime: false,
    utcStart: '2026-05-04T07:00:00Z', utcEnd: '2026-05-04T07:15:00Z', status: 'confirmed',
    participants: null, recurrenceRules: null, keywords: null, locations: null,
    ...over,
  } as CalendarEvent;
}

function task(over: Partial<CalendarTask>): CalendarTask {
  return {
    id: 't1', uid: 'tu1', '@type': 'Task', calendarIds: { 'cal-todo': true }, title: 'Pay rent',
    description: '', due: '2026-05-01', showWithoutTime: true, progress: 'needs-action', priority: 0,
    keywords: null,
    ...over,
  } as CalendarTask;
}

let client: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  client = {
    queryAllCalendarEvents: vi.fn(async () => [
      event({ id: 'late', start: '2026-05-06T10:00:00', utcStart: '2026-05-06T08:00:00Z', calendarIds: { 'cal-home': true } }),
      event({}),
    ]),
    getCalendarEvent: vi.fn(async (id: string) => (id === 'e1' ? event({}) : null)),
    createCalendarEvent: vi.fn(async (e: Partial<CalendarEvent>) => event({ ...e, id: 'new-1' })),
    updateCalendarEvent: vi.fn(async () => undefined),
    deleteCalendarEvent: vi.fn(async () => undefined),
    getCalendarTasks: vi.fn(async () => [task({}), task({ id: 't2', title: 'Done', progress: 'completed' })]),
    createCalendarTask: vi.fn(async (t: Partial<CalendarTask>) => task({ ...t, id: 'new-t' })),
    updateCalendarTask: vi.fn(async (id: string) => id),
    deleteCalendarTask: vi.fn(async () => undefined),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient });
  useCalendarStore.setState({ calendars: [work, todo], events: [], error: null });
  useTaskStore.setState({ tasks: [] });
  useIdentityStore.setState({
    identities: [{ id: 'id1', name: 'Ann', email: 'ann@example.com' }] as never,
    preferredPrimaryId: null,
  });
  useSettingsStore.setState({ timeZone: 'Europe/Berlin' } as never);
});

afterEach(() => {
  useAuthStore.setState({ client: null });
  useCalendarStore.setState({ calendars: [], events: [] });
  useTaskStore.setState({ tasks: [] });
  useIdentityStore.setState({ identities: [] });
  calendarHooks.onBeforeEventCreate.removePlugin('veto');
  taskHooks.onBeforeTaskDelete.removePlugin('veto');
});

const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

describe('api.calendar', () => {
  it('lists calendars as plain views', async () => {
    expect(await call(READ, 'calendar.listCalendars')).toEqual([
      { id: 'cal-work', name: 'Work', color: '#f00', isVisible: true, isDefault: true, isTasksOnly: false },
      { id: 'cal-todo', name: 'To do', color: '', isVisible: true, isDefault: false, isTasksOnly: true },
    ]);
  });

  it('returns events in a range earliest first, filtered by calendar', async () => {
    const all = await call(READ, 'calendar.getEvents', { from: '2026-05-01', to: '2026-06-01' }) as { id: string }[];
    expect(all.map((e) => e.id)).toEqual(['e1', 'late']);
    expect(client.queryAllCalendarEvents).toHaveBeenCalledWith({ after: '2026-05-01T00:00:00', before: '2026-06-01T00:00:00' });
    const work = await call(READ, 'calendar.getEvents', { from: '2026-05-01', to: '2026-06-01', calendarIds: ['cal-work'] }) as { id: string; title: string }[];
    expect(work).toEqual([expect.objectContaining({ id: 'e1', title: 'Standup', calendarId: 'cal-work' })]);
  });

  it('refuses a range over a year, a reversed range and junk dates', async () => {
    await expect(call(READ, 'calendar.getEvents', { from: '2026-01-01', to: '2027-01-03' })).rejects.toThrow(/at most 366 days/);
    await expect(call(READ, 'calendar.getEvents', { from: '2026-05-02', to: '2026-05-01' })).rejects.toThrow(/after from/);
    await expect(call(READ, 'calendar.getEvents', { from: '2026-02-30', to: '2026-03-01' })).rejects.toThrow(/not a real date/);
    await expect(call(READ, 'calendar.getEvents', { from: 'tomorrow', to: '2026-03-01' })).rejects.toThrow(/must look like/);
    expect(client.queryAllCalendarEvents).not.toHaveBeenCalled();
  });

  it('gets one event or null', async () => {
    expect(await call(READ, 'calendar.getEvent', 'e1')).toEqual(expect.objectContaining({ id: 'e1', title: 'Standup' }));
    expect(await call(READ, 'calendar.getEvent', 'missing')).toBeNull();
    await expect(call(READ, 'calendar.getEvent', 42)).rejects.toThrow(/id must be a string/);
  });

  it('needs calendar:read to read and calendar:write to change', async () => {
    await expect(call(NONE, 'calendar.getEvents', { from: '2026-05-01', to: '2026-05-02' })).rejects.toThrow(/lacks permission "calendar:read"/);
    await expect(call(READ, 'calendar.createEvent', { title: 'x', start: '2026-05-01' })).rejects.toThrow(/lacks permission "calendar:write"/);
    await expect(call(READ, 'calendar.deleteEvent', 'e1')).rejects.toThrow(/lacks permission "calendar:write"/);
    expect(client.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it('creates a timed event from the plugin shape, in the default calendar, without invitations', async () => {
    const created = await call(WRITE, 'calendar.createEvent', {
      title: ' Review ', start: '2026-05-04T14:00', end: '2026-05-04T15:30', location: 'Room 1',
      participants: [{ email: 'bob@example.com', name: 'Bob' }],
    });
    expect(created).toEqual(expect.objectContaining({ id: 'new-1', title: 'Review', location: 'Room 1' }));
    const [sent, sendScheduling] = client.createCalendarEvent.mock.calls[0];
    expect(sendScheduling).toBe(false);
    expect(sent).toEqual(expect.objectContaining({
      title: 'Review', start: '2026-05-04T14:00:00', duration: 'PT1H30M', timeZone: 'Europe/Berlin',
      showWithoutTime: false, calendarIds: { 'cal-work': true }, organizerCalendarAddress: 'mailto:ann@example.com',
    }));
    const emails = Object.values(sent.participants as Record<string, { email: string }>).map((p) => p.email);
    expect(emails).toEqual(['ann@example.com', 'bob@example.com']);
    // The store saw it, so the calendar on screen shows it.
    expect(useCalendarStore.getState().events.map((e) => e.id)).toContain('new-1');
  });

  it('creates an all-day event with an exclusive end', async () => {
    await call(WRITE, 'calendar.createEvent', { title: 'Trip', start: '2026-05-01', end: '2026-05-04' });
    expect(client.createCalendarEvent.mock.calls[0][0]).toEqual(expect.objectContaining({
      start: '2026-05-01T00:00:00', duration: 'P3D', timeZone: null, showWithoutTime: true,
    }));
  });

  it('creates a yearly event under a uid in the plugin namespace', async () => {
    await call(WRITE, 'calendar.createEvent', {
      title: 'Birthday of Ada', start: '2026-12-10', uid: 'contact-42', repeat: { frequency: 'yearly' },
    });

    const sent = client.createCalendarEvent.mock.calls[0][0];
    expect(sent.uid).toMatch(/^contact-42@.+\.plugin\.bulwark$/);
    expect(sent.recurrenceRules).toEqual([expect.objectContaining({ '@type': 'RecurrenceRule', frequency: 'yearly', interval: 1, count: null, until: null })]);
  });

  it('checks repeat and uid', async () => {
    await expect(call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01', repeat: { frequency: 'hourly' } })).rejects.toThrow(/repeat.frequency/);
    await expect(call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01', repeat: { frequency: 'daily', count: 3, until: '2026-06-01' } })).rejects.toThrow(/not both/);
    await expect(call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01', uid: 'a b' })).rejects.toThrow(/uid must be/);
    await expect(call(WRITE, 'calendar.updateEvent', 'e1', { uid: 'other' })).rejects.toThrow(/unknown property "uid"/);
    expect(client.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('refuses arbitrary JSCalendar fields and bad input', async () => {
    await expect(call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01', recurrenceRules: [] }))
      .rejects.toThrow(/unknown property "recurrenceRules"/);
    await expect(call(WRITE, 'calendar.createEvent', { title: '', start: '2026-05-01' })).rejects.toThrow(/title must be 1-500/);
    await expect(call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01T10:00', timeZone: 'Mars/Base' }))
      .rejects.toThrow(/not a known time zone/);
    await expect(call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01T10:00', end: '2026-05-01T09:00' }))
      .rejects.toThrow(/end must be after start/);
    await expect(call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01', calendarId: 'nope' }))
      .rejects.toThrow(/no calendar with id "nope"/);
    expect(client.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('goes through the store, so another plugin can stop a create', async () => {
    calendarHooks.onBeforeEventCreate.register('veto', () => false);
    expect(await call(WRITE, 'calendar.createEvent', { title: 'x', start: '2026-05-01' })).toBeNull();
    expect(client.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('updates times against the event as it is and deletes through the store', async () => {
    await call(WRITE, 'calendar.updateEvent', 'e1', { start: '2026-05-04T10:00' });
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('e1', expect.objectContaining({
      start: '2026-05-04T10:00:00', duration: 'PT15M', timeZone: 'Europe/Berlin',
    }), false, undefined);
    await call(WRITE, 'calendar.deleteEvent', 'e1');
    expect(client.deleteCalendarEvent).toHaveBeenCalledWith('e1', false, undefined);
    await expect(call(WRITE, 'calendar.deleteEvent', 'missing')).rejects.toThrow(/no event with id "missing"/);
    await expect(call(WRITE, 'calendar.updateEvent', 'e1', {})).rejects.toThrow(/patch is empty/);
  });
});

describe('api.tasks', () => {
  it('lists open tasks, or all with includeCompleted', async () => {
    expect((await call(READ, 'tasks.list') as { id: string }[]).map((t) => t.id)).toEqual(['t1']);
    expect((await call(READ, 'tasks.list', { includeCompleted: true }) as { id: string }[]).map((t) => t.id)).toEqual(['t1', 't2']);
    expect(await call(READ, 'tasks.get', 't2')).toEqual(expect.objectContaining({ id: 't2', isComplete: true }));
    await expect(call(READ, 'tasks.list', { includeCompleted: 'yes' })).rejects.toThrow(/true or false/);
  });

  it('needs tasks:read and tasks:write', async () => {
    await expect(call(NONE, 'tasks.list')).rejects.toThrow(/lacks permission "tasks:read"/);
    await expect(call(READ, 'tasks.create', { title: 'x' })).rejects.toThrow(/lacks permission "tasks:write"/);
    expect(client.createCalendarTask).not.toHaveBeenCalled();
  });

  it('creates a task in the tasks calendar', async () => {
    const created = await call(WRITE, 'tasks.create', { title: 'Call Bob', due: '2026-05-02T17:00', priority: 1 });
    expect(created).toEqual(expect.objectContaining({ id: 'new-t', title: 'Call Bob', priority: 1 }));
    expect(client.createCalendarTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Call Bob', due: '2026-05-02T17:00:00', showWithoutTime: false, priority: 1,
      progress: 'needs-action', calendarIds: { 'cal-todo': true },
    }));
  });

  it('refuses bad task input', async () => {
    await expect(call(WRITE, 'tasks.create', { title: 'x', priority: 12 })).rejects.toThrow(/priority must be a whole number from 0 to 9/);
    await expect(call(WRITE, 'tasks.create', { title: 'x', progress: 'completed' })).rejects.toThrow(/unknown property "progress"/);
    await expect(call(WRITE, 'tasks.create', { title: 'x', due: '2026-05-02T17:00Z' })).rejects.toThrow(/without Z/);
    expect(client.createCalendarTask).not.toHaveBeenCalled();
  });

  it('completes, updates and deletes through the store', async () => {
    await call(WRITE, 'tasks.setComplete', 't1', true);
    expect(client.updateCalendarTask).toHaveBeenCalledWith('t1', { progress: 'completed' });
    client.updateCalendarTask.mockClear();
    await call(WRITE, 'tasks.setComplete', 't2', true);
    expect(client.updateCalendarTask).not.toHaveBeenCalled();
    await call(WRITE, 'tasks.update', 't1', { due: null, title: 'Pay rent today' });
    expect(client.updateCalendarTask).toHaveBeenCalledWith('t1', { title: 'Pay rent today', due: null, showWithoutTime: true });

    taskHooks.onBeforeTaskDelete.register('veto', () => false);
    await call(WRITE, 'tasks.delete', 't1');
    expect(client.deleteCalendarTask).not.toHaveBeenCalled();
    await expect(call(WRITE, 'tasks.delete', 'nope')).rejects.toThrow(/no task with id "nope"/);
  });
});

describe('api.tasks alerts', () => {
  const at = (when: string, over: Partial<CalendarEventAlert> = {}): CalendarEventAlert => ({
    '@type': 'Alert', trigger: { '@type': 'AbsoluteTrigger', when }, action: 'display', acknowledged: null, relatedTo: null, ...over,
  });
  const updates = () => client.updateCalendarTask.mock.calls.map((c) => c[1] as Record<string, unknown>);

  it('creates a task with alerts, turning the calendar\'s defaults off', async () => {
    await call(WRITE, 'tasks.create', {
      title: 'Follow up: Offer',
      due: '2026-05-04',
      alerts: {
        'follow-up': { trigger: { at: '2026-05-04T07:00:00Z' } },
        'follow-up-mail': { trigger: { offset: '-PT1H' }, action: 'email' },
      },
    });
    expect(client.createCalendarTask).toHaveBeenCalledWith(expect.objectContaining({
      due: '2026-05-04', showWithoutTime: true, useDefaultAlerts: false,
      alerts: {
        'follow-up': at('2026-05-04T07:00:00Z'),
        'follow-up-mail': {
          '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT1H', relativeTo: 'end' },
          action: 'email', acknowledged: null, relatedTo: null,
        },
      },
    }));
  });

  it('returns them, each alert with whether it was acknowledged, and whether the defaults are in use', async () => {
    client.getCalendarTasks.mockResolvedValue([task({
      alerts: {
        a: at('2026-05-04T07:00:00Z', { acknowledged: '2026-05-04T07:01:00Z' }),
        b: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'email', acknowledged: null, relatedTo: null },
      },
    })]);
    expect(await call(READ, 'tasks.get', 't1')).toEqual(expect.objectContaining({
      alerts: {
        a: { trigger: { at: '2026-05-04T07:00:00Z' }, action: 'display', acknowledged: '2026-05-04T07:01:00Z' },
        b: { trigger: { offset: '-PT15M', relativeTo: 'start' }, action: 'email', acknowledged: null },
      },
      useDefaultAlerts: false,
    }));
    const [listed] = await call(READ, 'tasks.list') as { alerts: object }[];
    expect(Object.keys(listed.alerts)).toEqual(['a', 'b']);
  });

  it('refuses bad triggers, ids and too many alerts', async () => {
    const create = (over: Record<string, unknown>) => call(WRITE, 'tasks.create', { title: 'x', ...over });
    await expect(create({ alerts: [{ id: 'a', trigger: { offset: 'PT0S' } }] })).rejects.toThrow(/object keyed by id/);
    const six = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`a${i}`, { trigger: { offset: 'PT0S' } }]));
    await expect(create({ alerts: six })).rejects.toThrow(/at most 5 entries/);
    await expect(create({ alerts: { a: { trigger: { offset: 'P400D' } } } })).rejects.toThrow(/at most 366 days/);
    await expect(create({ alerts: { a: { trigger: { offset: 'P' } } } })).rejects.toThrow(/ISO 8601 duration/);
    await expect(create({ alerts: { a: { trigger: { at: '2026-05-04T09:00' } } } })).rejects.toThrow(/in UTC/);
    await expect(create({ alerts: { a: { trigger: { offset: 'PT0S' }, action: 'audio' } } })).rejects.toThrow(/display or email/);
    await expect(create({ alerts: { 'a b': { trigger: { offset: 'PT0S' } } } })).rejects.toThrow(/letters, digits/);
    expect(client.createCalendarTask).not.toHaveBeenCalled();
  });

  it('merges by id with patch paths, leaving alerts it did not name and other fields alone', async () => {
    useTaskStore.setState({ tasks: [task({
      title: 'Kept',
      alerts: { foreign: at('2026-05-04T06:00:00Z', { action: 'email' }), old: at('2026-05-04T05:00:00Z') },
    })] });
    await call(WRITE, 'tasks.update', 't1', {
      alerts: { 'follow-up': { trigger: { at: '2026-05-04T07:00:00Z' } }, old: null },
    });
    expect(updates()[0]).toEqual({
      'alerts/follow-up': at('2026-05-04T07:00:00Z'),
      'alerts/old': null,
    });
    const held = useTaskStore.getState().tasks[0];
    expect(held.title).toBe('Kept');
    expect(Object.keys(held.alerts ?? {})).toEqual(['foreign', 'follow-up']);

    await call(WRITE, 'tasks.update', 't1', { alerts: null });
    expect(updates()[1]).toEqual({ alerts: null });
  });

  it('writes the alerts whole on a task that has none yet', async () => {
    useTaskStore.setState({ tasks: [task({ alerts: null })] });
    await call(WRITE, 'tasks.update', 't1', { alerts: { a: { trigger: { at: '2026-05-04T07:00:00Z' } } } });
    expect(updates()[0]).toEqual({ alerts: { a: at('2026-05-04T07:00:00Z') } });
  });

  it('keeps an unchanged alert acknowledged and lets a snoozed one fire again', async () => {
    useTaskStore.setState({ tasks: [task({
      alerts: {
        a: at('2026-05-04T07:00:00Z', { acknowledged: '2026-05-04T07:01:00Z' }),
        b: at('2026-05-04T07:00:00Z', { acknowledged: '2026-05-04T07:01:00Z' }),
      },
    })] });
    await call(WRITE, 'tasks.update', 't1', { alerts: {
      a: { trigger: { at: '2026-05-04T07:00:00Z' } },
      b: { trigger: { at: '2026-05-04T08:00:00Z' } },
    } });
    expect(updates()[0]).toEqual({ 'alerts/b': at('2026-05-04T08:00:00Z') });
    const held = useTaskStore.getState().tasks[0];
    expect(held.alerts?.a.acknowledged).toBe('2026-05-04T07:01:00Z');
    expect(held.alerts?.b.acknowledged).toBeNull();
  });

  it('refuses a sixth alert counting those another app wrote', async () => {
    useTaskStore.setState({ tasks: [task({
      alerts: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`x${i}`, at('2026-05-04T07:00:00Z')])),
    })] });
    await expect(call(WRITE, 'tasks.update', 't1', { alerts: { new: { trigger: { offset: 'PT0S' } } } })).rejects.toThrow(/more than 5 alerts/);
    await call(WRITE, 'tasks.update', 't1', { alerts: { x1: null, new: { trigger: { offset: 'PT0S' } } } });
    expect(updates()[0]).toEqual({ 'alerts/x1': null, 'alerts/new': expect.objectContaining({ action: 'display' }) });
  });

  it('makes the calendar\'s default alerts the task\'s own under new ids, refusing a plugin alert under a default\'s id', async () => {
    useTaskStore.setState({ tasks: [task({
      useDefaultAlerts: true,
      alerts: { d1: at('2026-05-04T06:00:00Z'), d2: at('2026-05-04T06:30:00Z') },
    })] });
    expect(await call(READ, 'tasks.get', 't1')).toEqual(expect.objectContaining({ useDefaultAlerts: true }));
    await expect(call(WRITE, 'tasks.update', 't1', { alerts: { d1: { trigger: { offset: 'PT0S' } } } })).rejects.toThrow(/default alerts.*another id/);
    await expect(call(WRITE, 'tasks.acknowledgeAlert', 't1', 'd1')).rejects.toThrow(/useDefaultAlerts/);
    expect(client.updateCalendarTask).not.toHaveBeenCalled();

    await call(WRITE, 'tasks.update', 't1', { alerts: { d2: null, mine: { trigger: { at: '2026-05-04T07:00:00Z' } } } });
    expect(updates()[0]).toEqual({
      useDefaultAlerts: false,
      alerts: { alert1: at('2026-05-04T06:00:00Z'), mine: at('2026-05-04T07:00:00Z') },
    });
    useTaskStore.setState({ tasks: [task({ useDefaultAlerts: true, alerts: { d1: at('2026-05-04T06:00:00Z') } })] });
    await call(WRITE, 'tasks.update', 't1', { alerts: {} });
    expect(updates()[1]).toEqual({ useDefaultAlerts: false, alerts: { alert1: at('2026-05-04T06:00:00Z') } });
  });

  it('takes ids such as __proto__ and constructor as plain keys', async () => {
    await call(WRITE, 'tasks.create', {
      title: 'x',
      alerts: JSON.parse('{"__proto__": {"trigger": {"offset": "PT0S"}}, "constructor": {"trigger": {"offset": "PT0S"}}}'),
    });
    const created = client.createCalendarTask.mock.calls[0][0] as CalendarTask;
    expect(Object.getPrototypeOf(created.alerts)).toBe(Object.prototype);
    expect(Object.keys(created.alerts ?? {})).toEqual(['__proto__', 'constructor']);

    useTaskStore.setState({ tasks: [task({ alerts: { a: at('2026-05-04T07:00:00Z') } })] });
    await expect(call(WRITE, 'tasks.acknowledgeAlert', 't1', 'constructor')).rejects.toThrow(/no alert "constructor"/);
    await expect(call(WRITE, 'tasks.acknowledgeAlert', 't1', '__proto__')).rejects.toThrow(/no alert "__proto__"/);
    await call(WRITE, 'tasks.update', 't1', { alerts: JSON.parse('{"__proto__": {"trigger": {"offset": "PT0S"}}}') });
    expect(updates()[0]).toEqual(JSON.parse('{"alerts/__proto__": {"@type": "Alert", "trigger": {"@type": "OffsetTrigger", "offset": "PT0S", "relativeTo": "end"}, "action": "display", "acknowledged": null, "relatedTo": null}}'));
    const held = useTaskStore.getState().tasks[0];
    expect(Object.getPrototypeOf(held.alerts)).toBe(Object.prototype);
    expect(Object.keys(held.alerts ?? {})).toEqual(['a', '__proto__']);
  });

  it('acknowledges an alert by its path, now or at a given time, and undoes it', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-04T07:02:03.456Z'), toFake: ['Date'] });
    try {
      useTaskStore.setState({ tasks: [task({ alerts: { a: at('2026-05-04T07:00:00Z'), b: at('2026-05-04T07:00:00Z', { action: 'email' }) } })] });
      await call(WRITE, 'tasks.acknowledgeAlert', 't1', 'a');
      expect(client.updateCalendarTask).toHaveBeenLastCalledWith('t1', { 'alerts/a/acknowledged': '2026-05-04T07:02:03Z' });
      expect(useTaskStore.getState().tasks[0].alerts?.a.acknowledged).toBe('2026-05-04T07:02:03Z');
      await call(WRITE, 'tasks.acknowledgeAlert', 't1', 'b', '2026-05-04T06:00:00Z');
      expect(useTaskStore.getState().tasks[0].alerts?.b.acknowledged).toBe('2026-05-04T06:00:00Z');
      await call(WRITE, 'tasks.acknowledgeAlert', 't1', 'a', null);
      expect(client.updateCalendarTask).toHaveBeenLastCalledWith('t1', { 'alerts/a/acknowledged': null });
      expect(await call(READ, 'tasks.get', 't1')).toEqual(expect.objectContaining({
        alerts: expect.objectContaining({ a: expect.objectContaining({ acknowledged: null }) }),
      }));

      client.updateCalendarTask.mockClear();
      await call(WRITE, 'tasks.acknowledgeAlert', 't1', 'a', null);
      expect(client.updateCalendarTask).not.toHaveBeenCalled();
      await expect(call(WRITE, 'tasks.acknowledgeAlert', 't1', 'zz')).rejects.toThrow(/no alert "zz"/);
      await expect(call(WRITE, 'tasks.acknowledgeAlert', 't1', 'a', '2026-05-04T06:00')).rejects.toThrow(/in UTC/);
      await expect(call(READ, 'tasks.acknowledgeAlert', 't1', 'a')).rejects.toThrow(/lacks permission "tasks:write"/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acknowledges two alerts at once one after the other, neither undoing the other', async () => {
    useTaskStore.setState({ tasks: [task({ alerts: { a: at('2026-05-04T07:00:00Z'), b: at('2026-05-04T07:00:00Z') } })] });
    let inFlight = 0;
    let most = 0;
    client.updateCalendarTask.mockImplementation(async (id: string) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return id;
    });
    await Promise.all([
      call(WRITE, 'tasks.acknowledgeAlert', 't1', 'a', '2026-05-04T07:01:00Z'),
      call(WRITE, 'tasks.acknowledgeAlert', 't1', 'b', '2026-05-04T07:02:00Z'),
    ]);
    // Stalwart refuses a second set on an object while one is under way.
    expect(most).toBe(1);
    expect(updates()).toEqual([
      { 'alerts/a/acknowledged': '2026-05-04T07:01:00Z' },
      { 'alerts/b/acknowledged': '2026-05-04T07:02:00Z' },
    ]);
    const alerts = useTaskStore.getState().tasks[0].alerts;
    expect([alerts?.a.acknowledged, alerts?.b.acknowledged]).toEqual(['2026-05-04T07:01:00Z', '2026-05-04T07:02:00Z']);
  });

  it('acknowledges an alert of a task the list does not hold, emitting the whole task', async () => {
    const full = task({ title: 'From the server', alerts: { a: at('2026-05-04T07:00:00Z'), b: at('2026-05-04T08:00:00Z') } });
    client.getCalendarTasks.mockResolvedValue([full]);
    const seen: { patch: Record<string, unknown> }[] = [];
    const emitted: { title: string; alerts: Record<string, { acknowledged: string | null }> }[] = [];
    taskHooks.onBeforeTaskUpdate.register('watch', (e: unknown) => { seen.push(e as { patch: Record<string, unknown> }); return true; });
    taskHooks.onTaskUpdate.register('watch', (v: unknown) => { emitted.push(v as never); });
    try {
      await call(WRITE, 'tasks.acknowledgeAlert', 't1', 'a', '2026-05-04T07:01:00Z');
      expect(updates()).toEqual([{ 'alerts/a/acknowledged': '2026-05-04T07:01:00Z' }]);
      expect(Object.keys(seen[0].patch.alerts as object)).toEqual(['a', 'b']);
      await vi.waitFor(() => expect(emitted).toHaveLength(1));
      expect(emitted[0].title).toBe('From the server');
      expect(emitted[0].alerts.a.acknowledged).toBe('2026-05-04T07:01:00Z');
      expect(emitted[0].alerts.b.acknowledged).toBeNull();
    } finally {
      taskHooks.onBeforeTaskUpdate.removePlugin('watch');
      taskHooks.onTaskUpdate.removePlugin('watch');
    }
  });

  it('decides on the alerts as the server holds them, not an older copy in the list', async () => {
    useTaskStore.setState({ tasks: [task({ alerts: null })] });
    client.getCalendarEvent.mockImplementation(async (id: string) => (id === 't1'
      ? { id: 't1', alerts: { other: at('2026-05-04T06:00:00Z', { action: 'email' }) } }
      : null));
    await call(WRITE, 'tasks.update', 't1', { alerts: { mine: { trigger: { at: '2026-05-04T07:00:00Z' } } } });
    expect(updates()[0]).toEqual({ 'alerts/mine': at('2026-05-04T07:00:00Z') });
    const held = useTaskStore.getState().tasks[0];
    expect(Object.keys(held.alerts ?? {})).toEqual(['other', 'mine']);
    expect(client.getCalendarEvent).toHaveBeenCalledWith('t1', undefined);
  });

  it('turns the calendar\'s default alerts off when every alert is removed', async () => {
    useTaskStore.setState({ tasks: [task({ useDefaultAlerts: true, alerts: { d1: at('2026-05-04T06:00:00Z') } })] });
    await call(WRITE, 'tasks.update', 't1', { alerts: null });
    expect(updates()[0]).toEqual({ alerts: null, useDefaultAlerts: false });
  });
});
