import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { CalendarTask } from '../jmap/types';
import { jmapErrorType } from '../jmap/jmap-error';
import wire from './fixtures/stalwart-task-due-wire.json';

function makeSession() {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:calendars': {} },
    accounts: {
      'acct-1': { name: 'test', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1', 'urn:ietf:params:jmap:calendars': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: '',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

type Call = { method: string; args: Record<string, unknown> };

const isBareDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Whether Stalwart keeps a task due of this shape in the stored iCalendar,
 * read from recorded round trips: it echoes a bare date over JMAP but writes
 * no DUE, so CalDAV clients lose the date.
 */
function stalwartKeepsDue(due: string): boolean {
  const rows = wire.allDayTaskDue.filter((row) => row.write.patch && isBareDate(row.write.patch.due) === isBareDate(due));
  if (rows.length === 0) throw new Error(`no recorded round trip for a due like ${due}`);
  return rows.every((row) => row.icalDue !== null);
}

/** What the task modal sends on save: every field, here for an all-day task. */
const modalPayload = (due: string | null): Partial<CalendarTask> => ({
  '@type': 'Task',
  title: 'Pay rent',
  description: '',
  due,
  showWithoutTime: true,
  priority: 0,
  progress: 'needs-action',
  calendarIds: { 'cal-1': true },
});

describe('JMAPClient task operations (#958)', () => {
  let client: JMAPClient;
  let sentCalls: Call[];

  beforeEach(() => {
    sentCalls = [];
    client = new JMAPClient('https://mail.example.com', 'test', 'pass');
    // Simulate active session
    (client as unknown as { session: unknown; accountId: string; apiUrl: string }).session = makeSession();
    (client as unknown as { accountId: string }).accountId = 'acct-1';
    (client as unknown as { apiUrl: string }).apiUrl = 'https://mail.example.com/jmap/api';
    (client as unknown as { accounts: Record<string, unknown> }).accounts = makeSession().accounts;

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) || '{}');
      const calls = (body.methodCalls || []) as [string, Record<string, unknown>, string][];
      const methodResponses: [string, Record<string, unknown>, string][] = [];

      for (const [method, args, tag] of calls) {
        sentCalls.push({ method, args });

        if (method === 'CalendarEvent/set') {
          const update = args.update as Record<string, unknown> | undefined;
          const create = args.create as Record<string, unknown> | undefined;
          const updated: Record<string, unknown> = {};
          const created: Record<string, unknown> = {};

          if (update) {
            for (const id of Object.keys(update)) {
              updated[id] = { id };
            }
          }
          if (create) {
            for (const id of Object.keys(create)) {
              created[id] = { id: 'created-id-123' };
            }
          }

          methodResponses.push(['CalendarEvent/set', { updated, created, notUpdated: {}, notCreated: {} }, tag]);
        } else if (method === 'CalendarEvent/get') {
          methodResponses.push([
            'CalendarEvent/get',
            {
              list: [
                {
                  id: 'created-id-123',
                  '@type': 'Task',
                  uid: 'uid-123',
                  title: 'Task Title',
                  progress: 'needs-action',
                  calendarIds: { 'cal-1': true },
                },
              ],
              notFound: [],
            },
            tag,
          ]);
        }
      }

      return jsonResponse({ methodResponses });
    }));
  });

  it('updateCalendarTask strips progressUpdated before sending CalendarEvent/set (#958)', async () => {
    const updates: Partial<CalendarTask> & { progressUpdated?: string | null } = {
      progress: 'completed',
      progressUpdated: '2026-09-06T12:00:00Z',
    };

    await client.updateCalendarTask('task-123', updates as Partial<CalendarTask>);

    const setCall = sentCalls.find((c) => c.method === 'CalendarEvent/set');
    expect(setCall).toBeDefined();

    const updatePayload = (setCall?.args.update as Record<string, Record<string, unknown>>)?.['task-123'];
    expect(updatePayload).toBeDefined();
    expect(updatePayload.progress).toBe('completed');
    expect(updatePayload).not.toHaveProperty('progressUpdated');
  });

  it('createCalendarTask strips progressUpdated before sending CalendarEvent/set', async () => {
    const task: Partial<CalendarTask> & { progressUpdated?: string | null } = {
      title: 'New Task',
      progress: 'needs-action',
      progressUpdated: '2026-09-06T12:00:00Z',
    };

    await client.createCalendarTask(task as Partial<CalendarTask>);

    const setCall = sentCalls.find((c) => c.method === 'CalendarEvent/set');
    expect(setCall).toBeDefined();

    const createPayload = (setCall?.args.create as Record<string, Record<string, unknown>>)?.['new-task'];
    expect(createPayload).toBeDefined();
    expect(createPayload['@type']).toBe('Task');
    expect(createPayload.title).toBe('New Task');
    expect(createPayload).not.toHaveProperty('progressUpdated');
  });

  it('createCalendarTask reads the task back without utcStart/utcEnd', async () => {
    await client.createCalendarTask({ title: 'New Task' });

    const getCall = sentCalls.find((c) => c.method === 'CalendarEvent/get');
    expect(getCall?.args.properties).toEqual(expect.arrayContaining(['due', 'progress', 'recurrenceOverrides']));
    expect(getCall?.args.properties).not.toContain('utcStart');
    expect(getCall?.args.properties).not.toContain('utcEnd');
  });

  it('createCalendarTask returns the created task when Stalwart 1.0 refuses the read-back, without creating it twice', async () => {
    const answer = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const body = JSON.parse((init?.body as string) || '{}');
      if (body.methodCalls?.[0]?.[0] === 'CalendarEvent/get') {
        sentCalls.push({ method: 'CalendarEvent/get', args: body.methodCalls[0][1] });
        return jsonResponse({ methodResponses: [['error', {
          type: 'invalidArguments',
          description: 'recurrenceOverrides cannot be requested together with utcStart or utcEnd',
        }, '0']] });
      }
      return answer(url, init);
    });

    const created = await client.createCalendarTask({ title: 'New Task', due: '2026-09-30T00:00:00', calendarIds: { 'cal-1': true } });

    expect(created).toMatchObject({ id: 'created-id-123', '@type': 'Task', title: 'New Task', due: '2026-09-30T00:00:00' });
    expect(sentCalls.filter((c) => c.method === 'CalendarEvent/set')).toHaveLength(1);
  });

  it('getCalendarTasks fails instead of returning no tasks when the server refuses the query', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => jsonResponse({
      methodResponses: [['error', { type: 'serverFail', description: 'Store unavailable' }, '0']],
    }));

    await expect(client.getCalendarTasks()).rejects.toThrow(/Store unavailable/);
  });

  it('createCalendarTask fails with the error type when the server refuses the whole call', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => jsonResponse({
      methodResponses: [['error', { type: 'invalidArguments', description: 'Invalid calendar id' }, '0']],
    }));

    const error = await client.createCalendarTask({ title: 'New Task' }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Invalid calendar id');
    expect(jmapErrorType(error)).toBe('invalidArguments');
  });

  const sentTask = (kind: 'create' | 'update', key: string) => {
    const setCall = sentCalls.find((c) => c.method === 'CalendarEvent/set');
    return (setCall?.args[kind] as Record<string, Record<string, unknown>>)[key];
  };

  it.each([
    ['createCalendarTask', 'create', 'new-task', (c: JMAPClient) => c.createCalendarTask(modalPayload('2026-10-07'))],
    ['updateCalendarTask', 'update', 'task-1', (c: JMAPClient) => c.updateCalendarTask('task-1', modalPayload('2026-10-07'))],
  ] as const)('%s sends an all-day due as a LocalDateTime, which Stalwart keeps in the iCalendar', async (_name, kind, key, write) => {
    await write(client);

    const due = sentTask(kind, key).due as string;
    expect(due).toBe('2026-10-07T00:00:00');
    expect(stalwartKeepsDue(due)).toBe(true);
  });

  it('completes a bare start date as well and leaves a due with a time alone', async () => {
    await client.updateCalendarTask('task-1', { start: '2026-10-01', due: '2026-10-14T09:30:00' });
    expect(sentTask('update', 'task-1')).toMatchObject({ start: '2026-10-01T00:00:00', due: '2026-10-14T09:30:00' });
  });

  it('keeps a cleared due cleared', async () => {
    await client.updateCalendarTask('task-1', modalPayload(null));
    expect(sentTask('update', 'task-1').due).toBeNull();
  });

  // An RRULE needs a DTSTART (RFC 5545), and servers drop a task's
  // recurrenceRule without a `start`, silently. A new recurring task the form
  // sends with a due only starts at that due.
  const weekly = { recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' } as never] };
  it('createCalendarTask anchors a new recurring task without start at its due, so the server keeps the rule', async () => {
    await client.createCalendarTask({ ...modalPayload('2026-11-10'), ...weekly });
    expect(sentTask('create', 'new-task')).toMatchObject({ start: '2026-11-10T00:00:00', due: '2026-11-10T00:00:00', recurrenceRule: { frequency: 'weekly' } });
  });

  it('updateCalendarTask does not invent a start when the patch has no start', async () => {
    await client.updateCalendarTask('task-1', { ...modalPayload('2026-11-10'), ...weekly });
    expect(sentTask('update', 'task-1')).not.toHaveProperty('start');
  });

  it('gives a task without recurrence no start', async () => {
    await client.createCalendarTask(modalPayload('2026-11-10'));
    expect(sentTask('create', 'new-task')).not.toHaveProperty('start');
  });

  it('keeps a start the recurring task already has', async () => {
    await client.updateCalendarTask('task-1', { ...modalPayload('2026-11-10T09:00:00'), start: '2026-11-03T09:00:00', ...weekly });
    expect(sentTask('update', 'task-1').start).toBe('2026-11-03T09:00:00');
  });
});

describe('JMAPClient tasks in shared calendars (#1204)', () => {
  let client: JMAPClient;
  let sentCalls: Call[];

  // Tasks per account as the server stores them (bare ids).
  const serverTasks: Record<string, Record<string, unknown>[]> = {
    'acct-1': [{ id: 'own-1', '@type': 'Task', uid: 'uid-own', title: 'Mine', progress: 'needs-action', calendarIds: { 'cal-1': true }, created: '2026-10-01T00:00:00Z', isDraft: false, isOrigin: true, locations: { l1: { '@type': 'Location', name: 'Desk' } } },
      // Saved by a client that sent a bare date: Stalwart echoes it as such.
      { id: 'own-2', '@type': 'Task', uid: 'uid-due', title: 'Dated', progress: 'needs-action', calendarIds: { 'cal-1': true }, due: wire.allDayTaskDue[0].jmapAfter.due, showWithoutTime: true }],
    'acct-2': [{ id: 'shared-1', '@type': 'Task', uid: 'uid-shared', title: 'Theirs', progress: 'needs-action', calendarIds: { 'cal-s': true } }],
  };

  beforeEach(() => {
    sentCalls = [];
    const session = makeSession();
    session.accounts = {
      ...session.accounts,
      'acct-2': { name: 'owner', isPersonal: false, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
    } as typeof session.accounts;
    client = new JMAPClient('https://mail.example.com', 'test', 'pass');
    (client as unknown as { session: unknown }).session = session;
    (client as unknown as { accountId: string }).accountId = 'acct-1';
    (client as unknown as { apiUrl: string }).apiUrl = session.apiUrl;
    (client as unknown as { accounts: Record<string, unknown> }).accounts = session.accounts;

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) || '{}');
      const calls = (body.methodCalls || []) as [string, Record<string, unknown>, string][];
      const methodResponses: [string, Record<string, unknown>, string][] = [];
      for (const [method, args, tag] of calls) {
        sentCalls.push({ method, args });
        const list = serverTasks[args.accountId as string] ?? [];
        if (method === 'CalendarEvent/query') {
          methodResponses.push([method, { ids: list.map((t) => t.id) }, tag]);
        } else if (method === 'CalendarEvent/get') {
          const ids = args.ids as string[];
          const found = list.filter((t) => ids.includes(t.id as string));
          // A freshly created task is fetched back by its new id.
          const fresh = ids.includes('new-id') ? [{ id: 'new-id', '@type': 'Task', uid: 'uid-own', title: 'Mine', progress: 'needs-action', calendarIds: { 'cal-s': true } }] : [];
          methodResponses.push([method, { list: [...found, ...fresh], notFound: [] }, tag]);
        } else if (method === 'CalendarEvent/set') {
          const created = args.create ? { 'new-task': { id: 'new-id' } } : {};
          const updated = Object.fromEntries(Object.keys((args.update as object) ?? {}).map((id) => [id, null]));
          methodResponses.push([method, { created, updated, destroyed: args.destroy ?? [] }, tag]);
        }
      }
      return jsonResponse({ methodResponses });
    }));
  });

  it('lists tasks from shared accounts with namespaced ids and calendarIds', async () => {
    const tasks = await client.getCalendarTasks();
    const shared = tasks.find((t) => t.title === 'Theirs');
    expect(shared?.id).toBe('acct-2:shared-1');
    expect(shared?.calendarIds).toEqual({ 'acct-2:cal-s': true });
    expect(tasks.find((t) => t.title === 'Mine')?.id).toBe('own-1');
  });

  it('moves a task into a shared calendar by creating it there and destroying the original', async () => {
    const newId = await client.updateCalendarTask('own-1', { title: 'Mine', calendarIds: { 'acct-2:cal-s': true } });

    const sets = sentCalls.filter((c) => c.method === 'CalendarEvent/set');
    expect(sets).toHaveLength(2);
    const [create, destroy] = sets;
    expect(create.args.accountId).toBe('acct-2');
    const payload = (create.args.create as Record<string, Record<string, unknown>>)['new-task'];
    expect(payload.calendarIds).toEqual({ 'cal-s': true });
    expect(payload.uid).toBe('uid-own');
    expect(payload.locations).toEqual({ l1: { '@type': 'Location', name: 'Desk' } });
    for (const key of ['id', 'created', 'isDraft', 'isOrigin']) expect(payload).not.toHaveProperty(key);
    expect(destroy.args).toMatchObject({ accountId: 'acct-1', destroy: ['own-1'] });
    expect(newId).toBe('acct-2:new-id');
  });

  it('moving a task with a bare due date to another account stores the due as a LocalDateTime', async () => {
    await client.updateCalendarTask('own-2', { calendarIds: { 'acct-2:cal-s': true } });

    const create = sentCalls.find((c) => c.method === 'CalendarEvent/set' && c.args.create);
    const due = (create?.args.create as Record<string, Record<string, unknown>>)['new-task'].due as string;
    expect(due).toBe('2026-10-14T00:00:00');
    expect(stalwartKeepsDue(due)).toBe(true);
  });

  it('updates a shared task in place in its own account with real ids', async () => {
    const id = await client.updateCalendarTask('acct-2:shared-1', { progress: 'completed', calendarIds: { 'acct-2:cal-s': true } });

    const sets = sentCalls.filter((c) => c.method === 'CalendarEvent/set');
    expect(sets).toHaveLength(1);
    expect(sets[0].args.accountId).toBe('acct-2');
    expect(sets[0].args.update).toEqual({ 'shared-1': { progress: 'completed', calendarIds: { 'cal-s': true } } });
    expect(id).toBe('acct-2:shared-1');
  });

  it('creates a task in a shared calendar in the owning account', async () => {
    const created = await client.createCalendarTask({ title: 'New', calendarIds: { 'acct-2:cal-s': true } });
    const set = sentCalls.find((c) => c.method === 'CalendarEvent/set');
    expect(set?.args.accountId).toBe('acct-2');
    expect((set?.args.create as Record<string, Record<string, unknown>>)['new-task'].calendarIds).toEqual({ 'cal-s': true });
    expect(created.id).toBe('acct-2:new-id');
  });
});
