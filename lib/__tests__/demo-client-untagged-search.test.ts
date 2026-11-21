import { describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '@/lib/demo/demo-client';
import { DEMO_KEYWORDS } from '@/lib/demo/fixtures/keywords';
import { buildJMAPFilter, DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { getEmailTagIds } from '@/lib/thread-utils';

// The "No tags" filter is an AND of notKeyword conditions; the demo inbox
// holds tagged mail, so the demo client must honour every one of them.
describe('DemoJMAPClient untagged search', () => {
  it('returns only the inbox mail without a tag', async () => {
    const client = new DemoJMAPClient();
    const inbox = (await client.getMailboxes()).find((m) => m.role === 'inbox')!;
    const all = await client.advancedSearchEmails({ inMailbox: inbox.id }, undefined, 500);
    const tagIds = DEMO_KEYWORDS.map((k) => k.id);
    expect(all.emails.some((e) => getEmailTagIds(e.keywords).length > 0)).toBe(true);

    const filter = buildJMAPFilter('', { ...DEFAULT_SEARCH_FILTERS, untagged: true }, inbox.id, tagIds);
    const { emails } = await client.advancedSearchEmails(filter, undefined, 500);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => getEmailTagIds(e.keywords).length === 0)).toBe(true);
    expect(emails.length).toBe(all.emails.filter((e) => getEmailTagIds(e.keywords).length === 0).length);
  });
});
