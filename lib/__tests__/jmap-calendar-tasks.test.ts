import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { CalendarTask } from '../jmap/types';

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
});
