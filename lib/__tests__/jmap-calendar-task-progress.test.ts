import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

const SESSION = {
  capabilities: {
    'urn:ietf:params:jmap:core': {},
    'urn:ietf:params:jmap:calendars': {},
  },
  accounts: {
    'acct-1': {
      name: 'user@test.com',
      isPersonal: true,
      accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} },
    },
  },
  primaryAccounts: {
    'urn:ietf:params:jmap:mail': 'acct-1',
    'urn:ietf:params:jmap:calendars': 'acct-1',
  },
  apiUrl: 'https://mail.example.com/jmap/api',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function task(id: string, progress: unknown): Record<string, unknown> {
  return {
    id,
    '@type': 'Task',
    uid: `${id}@example.com`,
    calendarIds: { personal: true },
    title: id,
    progress,
  };
}

describe('JMAP calendar task progress compatibility', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(json(SESSION));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();
  });

  afterEach(() => {
    client.disconnect();
    fetchSpy.mockRestore();
  });

  it('normalizes known CalDAV spellings returned by CalendarEvent/query and /get', async () => {
    const returnedTasks = [
      task('upper-cancelled', 'CANCELLED'),
      task('single-l-canceled', 'canceled'),
      task('underscore-needs-action', 'NEEDS_ACTION'),
      task('underscore-in-process', 'IN_PROCESS'),
    ];

    fetchSpy
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/query', { ids: returnedTasks.map(({ id }) => id) }, '0']],
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/get', { list: returnedTasks, notFound: [] }, '0']],
      }));

    const tasks = await client.getCalendarTasks();

    expect(tasks.map(({ progress }) => progress)).toEqual([
      'cancelled',
      'cancelled',
      'needs-action',
      'in-process',
    ]);
  });

  it('preserves unknown and non-string progress values without prototype lookups', async () => {
    const returnedTasks = [
      task('constructor', 'constructor'),
      task('proto', '__proto__'),
      task('future-value', 'blocked'),
      task('numeric-value', 42),
      task('null-value', null),
    ];

    fetchSpy
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/query', { ids: returnedTasks.map(({ id }) => id) }, '0']],
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/get', { list: returnedTasks, notFound: [] }, '0']],
      }));

    const tasks = await client.getCalendarTasks();

    expect(tasks.map(({ progress }) => progress as unknown)).toEqual([
      'constructor',
      '__proto__',
      'blocked',
      42,
      null,
    ]);
  });

  it('normalizes progress on task create refetch', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/set', { created: { 'new-task': { id: 'created-id' } } }, '0']],
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/get', {
          list: [task('created-id', 'IN_PROCESS')],
          notFound: [],
        }, '0']],
      }));

    const created = await client.createCalendarTask({
      title: 'created task',
      calendarIds: { personal: true },
    });

    expect(created.progress).toBe('in-process');
  });

  it('preserves unknown and non-string progress on task create refetch', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/set', { created: { 'new-task': { id: 'future-id' } } }, '0']],
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/get', {
          list: [task('future-id', 'constructor')],
          notFound: [],
        }, '0']],
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/set', { created: { 'new-task': { id: 'numeric-id' } } }, '0']],
      }))
      .mockResolvedValueOnce(json({
        methodResponses: [['CalendarEvent/get', {
          list: [task('numeric-id', 42)],
          notFound: [],
        }, '0']],
      }));

    const future = await client.createCalendarTask({
      title: 'future task',
      calendarIds: { personal: true },
    });
    const numeric = await client.createCalendarTask({
      title: 'numeric task',
      calendarIds: { personal: true },
    });

    expect(future.progress as unknown).toBe('constructor');
    expect(numeric.progress as unknown).toBe(42);
  });
});
