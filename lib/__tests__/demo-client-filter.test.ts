import { describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '@/lib/demo/demo-client';

// A `header` condition used to be ignored, so it matched every message. The
// category tabs' Promotions rule has one, which left the default tab (NOT all
// the other tabs) empty on an Inbox full of mail.
describe('DemoJMAPClient header filter', () => {
  async function inboxOf(client: DemoJMAPClient) {
    return (await client.getMailboxes()).find((m) => m.role === 'inbox')!;
  }

  it('matches only messages that carry the header', async () => {
    const client = new DemoJMAPClient();
    const inbox = await inboxOf(client);
    const all = await client.getEmails(inbox.id, undefined, 500);
    const listed = await client.getEmails(inbox.id, undefined, 500, 0, undefined, false, { header: ['List-Id'] });

    expect(listed.total).toBeGreaterThan(0);
    expect(listed.total).toBeLessThan(all.total);
    for (const e of listed.emails) {
      expect(Object.keys(e.headers ?? {}).map((h) => h.toLowerCase())).toContain('list-id');
    }
  });

  it('compares the value when the condition has one', async () => {
    const client = new DemoJMAPClient();
    const inbox = await inboxOf(client);
    const hit = await client.getEmails(inbox.id, undefined, 500, 0, undefined, false, { header: ['list-id', 'BEACON.meridianlabs'] });
    const miss = await client.getEmails(inbox.id, undefined, 500, 0, undefined, false, { header: ['List-Id', 'no-such-list'] });

    expect(hit.total).toBeGreaterThan(0);
    expect(miss.total).toBe(0);
  });

  it('leaves mail in a default tab that excludes a header rule', async () => {
    const client = new DemoJMAPClient();
    const inbox = await inboxOf(client);
    const primary = await client.getEmails(inbox.id, undefined, 500, 0, undefined, false, {
      operator: 'NOT',
      conditions: [{ operator: 'OR', conditions: [{ from: 'mailchimp' }, { header: ['List-Unsubscribe'] }] }],
    });

    expect(primary.total).toBeGreaterThan(0);
  });
});
