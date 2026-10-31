import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Calendar, CalendarEvent, CalendarTask } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useTaskStore } from '@/stores/task-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useContactStore } from '@/stores/contact-store';
import { BIRTHDAY_CALENDAR_ID, BIRTHDAY_CALENDAR_COLOR } from '@/lib/birthday-calendar';
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
  useSettingsStore.setState({ timeZone: 'Europe/Berlin', showBirthdayCalendar: false, birthdayCalendarColor: BIRTHDAY_CALENDAR_COLOR } as never);
  useContactStore.setState({ contacts: [], contactsLoaded: true });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
  useCalendarStore.setState({ calendars: [], events: [] });
  useTaskStore.setState({ tasks: [] });
  useIdentityStore.setState({ identities: [] });
  useSettingsStore.setState({ showBirthdayCalendar: false });
  useContactStore.setState({ contacts: [] });
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

  it('includes the virtual birthday calendar in listCalendars when showBirthdayCalendar is enabled', async () => {
    useSettingsStore.setState({ showBirthdayCalendar: true, birthdayCalendarColor: '#f59e0b' });
    const cals = await call(READ, 'calendar.listCalendars') as { id: string; name: string; color: string }[];
    expect(cals).toEqual([
      { id: 'cal-work', name: 'Work', color: '#f00', isVisible: true, isDefault: true, isTasksOnly: false },
      { id: 'cal-todo', name: 'To do', color: '', isVisible: true, isDefault: false, isTasksOnly: true },
      { id: BIRTHDAY_CALENDAR_ID, name: 'Birthdays', color: '#f59e0b', isVisible: true, isDefault: false, isTasksOnly: false },
    ]);
  });

  it('returns contact birthdays in getEvents when showBirthdayCalendar is enabled', async () => {
    useSettingsStore.setState({ showBirthdayCalendar: true });
    useContactStore.setState({
      contacts: [
        {
          id: 'c1',
          name: { full: 'Alice Smith' },
          anniversaries: { b1: { kind: 'birth', date: '1990-05-15' } },
        } as never,
      ],
    });

    const events = await call(READ, 'calendar.getEvents', { from: '2026-05-01', to: '2026-06-01' }) as {
      id: string; title: string; calendarId: string; isAllDay: boolean; start: string;
    }[];

    const birthday = events.find((e) => e.calendarId === BIRTHDAY_CALENDAR_ID);
    expect(birthday).toBeDefined();
    expect(birthday).toEqual(expect.objectContaining({
      id: 'birthday-c1-b1-2026',
      title: '🎂 Alice Smith (36)',
      calendarId: BIRTHDAY_CALENDAR_ID,
      isAllDay: true,
      start: '2026-05-15T00:00:00',
    }));

    // Respects calendarIds filtering
    const onlyWork = await call(READ, 'calendar.getEvents', {
      from: '2026-05-01', to: '2026-06-01', calendarIds: ['cal-work'],
    }) as { calendarId: string }[];
    expect(onlyWork.some((e) => e.calendarId === BIRTHDAY_CALENDAR_ID)).toBe(false);

    const onlyBirthdays = await call(READ, 'calendar.getEvents', {
      from: '2026-05-01', to: '2026-06-01', calendarIds: [BIRTHDAY_CALENDAR_ID],
    }) as { calendarId: string }[];
    expect(onlyBirthdays.every((e) => e.calendarId === BIRTHDAY_CALENDAR_ID)).toBe(true);

    // Can fetch a birthday event by ID
    const single = await call(READ, 'calendar.getEvent', 'birthday-c1-b1-2026');
    expect(single).toEqual(expect.objectContaining({
      id: 'birthday-c1-b1-2026',
      title: '🎂 Alice Smith (36)',
    }));

    // Birthday events cannot be mutated
    await expect(call(WRITE, 'calendar.updateEvent', 'birthday-c1-b1-2026', { title: 'New' }))
      .rejects.toThrow(/birthday events cannot be modified/);
    await expect(call(WRITE, 'calendar.deleteEvent', 'birthday-c1-b1-2026'))
      .rejects.toThrow(/birthday events cannot be modified/);
    await expect(call(WRITE, 'calendar.createEvent', {
      title: 'New', calendarId: BIRTHDAY_CALENDAR_ID, start: '2026-05-15T10:00', end: '2026-05-15T11:00',
    })).rejects.toThrow(/no calendar with id "__birthday-calendar__"/);
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
