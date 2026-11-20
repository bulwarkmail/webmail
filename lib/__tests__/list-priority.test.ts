import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { applyListPriority, emailPriority } from '../message-priority';
import { threadPriority } from '@/components/email/thread-list-item';
import type { Email } from '../jmap/types';

type Call = [string, Record<string, unknown>, string];

const X_PRIORITY = 'header:X-Priority:asText';
const IMPORTANCE = 'header:Importance:asText';

function recordingClient() {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'me', capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 50 } } });
  const gets: Record<string, unknown>[] = [];
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => ({
      methodResponses: calls.map(([method, args, id]) => {
        if (method === 'Email/query') return ['Email/query', { ids: ['m1', 'm2', 'm3'], total: 3, position: 0 }, id];
        if (method === 'Thread/get') return ['Thread/get', { list: [{ id: 't1', emailIds: ['m1', 'm2', 'm3'] }] }, id];
        if (method === 'Email/get') {
          gets.push(args);
          return ['Email/get', {
            list: [
              { id: 'm1', threadId: 't1', receivedAt: '2026-10-29T10:00:00Z', [X_PRIORITY]: '1 (Highest)', [IMPORTANCE]: null },
              { id: 'm2', threadId: 't2', receivedAt: '2026-10-29T09:00:00Z', [X_PRIORITY]: null, [IMPORTANCE]: 'Low' },
              { id: 'm3', threadId: 't3', receivedAt: '2026-10-29T08:00:00Z', [X_PRIORITY]: null, [IMPORTANCE]: null },
            ],
          }, id];
        }
        return [method, {}, id];
      }),
    }));
  return { client, gets };
}

// #1809: list rows mark high and low priority mail without opening it.
describe('list requests', () => {
  const fetches: Array<[string, (client: JMAPClient) => Promise<Array<Record<string, unknown>>>]> = [
    ['getSomeEmails', (c) => c.getSomeEmails(['m1', 'm2', 'm3']) as never],
    ['getEmails', async (c) => (await c.getEmails('inbox')).emails as never],
    ['searchEmails', async (c) => (await c.searchEmails('x')).emails as never],
    ['advancedSearchEmails', async (c) => (await c.advancedSearchEmails({ text: 'x' })).emails as never],
    ['getThreadEmails', (c) => c.getThreadEmails('t1') as never],
  ];

  it.each(fetches)('%s reads the priority from X-Priority and Importance', async (_name, fetch) => {
    const { client, gets } = recordingClient();
    const emails = await fetch(client);
    expect(gets.some((args) => {
      const properties = args.properties as string[];
      return properties.includes(X_PRIORITY) && properties.includes(IMPORTANCE);
    })).toBe(true);

    const byId = (id: string) => emails.find((e) => e.id === id)!;
    expect(byId('m1').priority).toBe('high');
    expect(byId('m2').priority).toBe('low');
    expect(byId('m3')).not.toHaveProperty('priority');
    for (const email of emails) {
      expect(email).not.toHaveProperty(X_PRIORITY);
      expect(email).not.toHaveProperty(IMPORTANCE);
    }
  });
});

describe('applyListPriority', () => {
  it('follows the composer rules: X-Priority wins, 1-2 high, 4-5 low', () => {
    const cases: Array<[unknown, unknown, string | undefined]> = [
      ['2 (High)', null, 'high'],
      ['5', 'high', 'low'],
      ['3 (Normal)', 'high', undefined],
      [null, 'HIGH', 'high'],
      [null, 'normal', undefined],
    ];
    for (const [xPriority, importance, expected] of cases) {
      const record: Record<string, unknown> = { id: 'm', [X_PRIORITY]: xPriority, [IMPORTANCE]: importance };
      applyListPriority(record);
      expect(record.priority).toBe(expected);
    }
  });
});

describe('emailPriority', () => {
  it('prefers the open message headers over the list value', () => {
    expect(emailPriority({ priority: 'high' })).toBe('high');
    expect(emailPriority({ priority: 'high', headers: { 'X-Priority': '3' } })).toBe('normal');
    expect(emailPriority({ headers: { Importance: 'low' } })).toBe('low');
    expect(emailPriority({})).toBe('normal');
  });
});

describe('threadPriority', () => {
  const email = (id: string, priority?: 'high' | 'low') => ({ id, priority }) as unknown as Email;
  it('is high if any message is, else the latest message decides', () => {
    const latest = email('c');
    expect(threadPriority([email('a', 'high'), email('b', 'low'), latest], latest)).toBe('high');
    const lowLatest = email('c', 'low');
    expect(threadPriority([email('a'), lowLatest], lowLatest)).toBe('low');
    expect(threadPriority([email('a', 'low'), latest], latest)).toBe('normal');
  });
});
