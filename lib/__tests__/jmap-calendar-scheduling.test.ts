import { describe, it, expect, vi } from 'vitest';
import { JMAPClient, SchedulingDeniedError } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

// Stalwart 0.16.21+ fails the whole CalendarEvent/set with `forbidden` when
// the account may not send iTIP messages; the UI can then save without them.
function clientRefusing(type: string) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'me' });
  vi.spyOn(client as unknown as { getCalendarsAccountId: () => string }, 'getCalendarsAccountId').mockReturnValue('me');
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => {
      const [, args, id] = calls[0];
      const error = { type, description: 'Scheduling is not allowed for this account' };
      return {
        methodResponses: [['CalendarEvent/set', args.create
          ? { notCreated: { 'new-event': error } }
          : { notUpdated: Object.fromEntries(Object.keys(args.update as object).map((k) => [k, error])) }, id]],
      };
    });
  return client;
}

describe('calendar scheduling refusals', () => {
  it('reports a refused invitation as SchedulingDeniedError', async () => {
    const client = clientRefusing('forbidden');
    await expect(client.createCalendarEvent({ title: 'Meet' }, true)).rejects.toBeInstanceOf(SchedulingDeniedError);
    await expect(client.updateCalendarEvent('e1', { title: 'Meet' }, true)).rejects.toThrow(SchedulingDeniedError);
  });

  it('keeps other failures as plain errors', async () => {
    await expect(clientRefusing('forbidden').createCalendarEvent({ title: 'Meet' }, false))
      .rejects.not.toBeInstanceOf(SchedulingDeniedError);
    await expect(clientRefusing('invalidProperties').createCalendarEvent({ title: 'Meet' }, true))
      .rejects.not.toBeInstanceOf(SchedulingDeniedError);
  });
});
