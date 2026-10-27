import { describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '@/lib/demo/demo-client';

// Global search sends several text parts to CalendarEvent/query as an AND
// (see calendarFilterFor). The demo client has to follow the operator: read
// as a flat filter, the AND has no text and would match every event.
describe('DemoJMAPClient calendar search', () => {
  it('evaluates an AND of a quoted phrase and a prefix', async () => {
    const client = new DemoJMAPClient();
    const events = await client.queryAllCalendarEvents({
      operator: 'AND',
      conditions: [{ text: '"lunch with"' }, { text: 'sar*' }],
    });
    expect(events.map((e) => e.title)).toEqual(['Lunch with Sarah: prototype v3']);
  });

  it('matches nothing when one part is missing', async () => {
    const client = new DemoJMAPClient();
    const events = await client.queryAllCalendarEvents({
      operator: 'AND',
      conditions: [{ text: '"lunch with"' }, { text: 'standup' }],
    });
    expect(events).toEqual([]);
  });

  it('still reads a flat text condition', async () => {
    const client = new DemoJMAPClient();
    const events = await client.queryAllCalendarEvents({ text: 'standup' });
    expect(events.map((e) => e.title)).toEqual(['Beacon standup']);
  });
});
