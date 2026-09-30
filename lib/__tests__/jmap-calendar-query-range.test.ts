import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { toLocalDateTime } from '../timezone';

type Call = [string, Record<string, unknown>, string];

function clientAnswering(answer: (args: Record<string, unknown>) => [string, Record<string, unknown>]) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'a1', capabilities: {}, session: { accounts: {}, primaryAccounts: {} } });
  const queries: Record<string, unknown>[] = [];
  vi.spyOn(client as unknown as { supportsSyntheticCalendarIds: () => Promise<boolean> }, 'supportsSyntheticCalendarIds')
    .mockResolvedValue(true);
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => {
      const [method, args, id] = calls[0];
      if (method === 'CalendarEvent/query') {
        queries.push(args);
        return { methodResponses: [[...answer(args), id]] };
      }
      const ids = (args.ids as string[]) ?? [];
      return {
        methodResponses: [['CalendarEvent/get', {
          list: ids.map((eid) => ({ id: eid, '@type': 'Event', start: '2026-09-22T10:00:00', duration: 'PT1H', calendarIds: { c: true } })),
        }, id]],
      };
    });
  return { client, queries };
}

describe('toLocalDateTime', () => {
  it('turns UTC and offset times into the wall clock of the zone', () => {
    expect(toLocalDateTime('2026-09-22T00:10:00Z', 'Europe/Berlin')).toBe('2026-09-22T02:10:00');
    expect(toLocalDateTime('2026-09-22T00:10:00.000Z', 'Europe/Berlin')).toBe('2026-09-22T02:10:00');
    expect(toLocalDateTime('2026-09-22T02:10:00+02:00')).toBe('2026-09-22T00:10:00');
  });

  it('leaves LocalDateTime values alone', () => {
    expect(toLocalDateTime('2026-09-22T02:10:00', 'Europe/Berlin')).toBe('2026-09-22T02:10:00');
  });
});

describe('queryCalendarEvents range handling', () => {
  it('sends UTC bounds as wall clock in the request time zone', async () => {
    const { client, queries } = clientAnswering(() => ['CalendarEvent/query', { ids: [] }]);
    await client.queryCalendarEvents({ after: '2026-09-22T00:10:00Z', before: '2026-09-22T00:20:00Z' });
    const filter = queries[0].filter as { after: string; before: string };
    const tz = queries[0].timeZone as string | undefined;
    expect(filter.after).toBe(toLocalDateTime('2026-09-22T00:10:00Z', tz));
    expect(filter.after.endsWith('Z')).toBe(false);
  });

  it('falls back to series when the range expands past the server limit', async () => {
    const { client, queries } = clientAnswering((args) => args.expandRecurrences
      ? ['error', { type: 'invalidArguments', description: 'The number of expanded recurrences exceeds the server limit' }]
      : ['CalendarEvent/query', { ids: ['s1'] }]);
    const events = await client.queryCalendarEvents({ after: '2020-01-01T00:00:00', before: '2030-01-01T00:00:00' });
    expect(queries.map((q) => !!q.expandRecurrences)).toEqual([true, false]);
    expect(events.map((e) => e.id)).toEqual(['s1']);
  });

  it('pages through more than one page of ids', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => `e${i}`);
    const { client, queries } = clientAnswering((args) => {
      const position = args.position as number;
      return ['CalendarEvent/query', { ids: all.slice(position, position + (args.limit as number)) }];
    });
    const events = await client.queryCalendarEvents({ after: '2026-09-01T00:00:00', before: '2026-10-01T00:00:00' });
    expect(queries.map((q) => q.position)).toEqual([0, 1000]);
    expect(events).toHaveLength(1500);
  });

  it('keeps an explicit limit to one page', async () => {
    const { client, queries } = clientAnswering(() => ['CalendarEvent/query', { ids: ['a', 'b'] }]);
    await client.queryCalendarEvents({ after: '2026-09-01T00:00:00', before: '2026-10-01T00:00:00' }, undefined, 2);
    expect(queries).toHaveLength(1);
    expect(queries[0].limit).toBe(2);
  });
});
