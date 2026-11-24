import { describe, it, expect } from 'vitest';
import { attachmentLink, eventAttachments, isAttachmentLink, linksWithAttachmentChanges } from '../calendar-attachments';
import { JMAPClient } from '../jmap/client';
import type { CalendarLink } from '../jmap/types';

// #1597: files attached to calendar events.

const link = (fields: Partial<CalendarLink>) => ({ '@type': 'Link', ...fields }) as CalendarLink;

describe('isAttachmentLink', () => {
  it('takes an enclosure with a blob or an address', () => {
    expect(isAttachmentLink(link({ rel: 'enclosure', blobId: 'b1' }))).toBe(true);
    expect(isAttachmentLink(link({ rel: 'enclosure', href: 'https://files.example.org/s/abc' }))).toBe(true);
    expect(isAttachmentLink(link({ rel: 'enclosure' }))).toBe(false);
  });

  it('takes a link without rel that holds a blob or points to a file', () => {
    expect(isAttachmentLink(link({ blobId: 'b1' }))).toBe(true);
    expect(isAttachmentLink(link({ href: 'https://example.org/docs/plan.pdf' }))).toBe(true);
    expect(isAttachmentLink(link({ href: 'https://example.org/meeting' }))).toBe(false);
  });

  it('leaves links with another rel alone', () => {
    expect(isAttachmentLink(link({ rel: 'icon', href: 'https://example.org/logo.png' }))).toBe(false);
    expect(isAttachmentLink(link({ rel: 'describedby', blobId: 'b1' }))).toBe(false);
  });
});

describe('eventAttachments', () => {
  it('lists blob and address attachments with a name, and opens only http(s) addresses', () => {
    const list = eventAttachments({
      links: {
        a: link({ rel: 'enclosure', blobId: 'b1', title: 'notes.txt', contentType: 'text/plain', size: 16 }),
        b: link({ rel: 'enclosure', href: 'https://example.org/files/Site%20plan.pdf' }),
        c: link({ rel: 'enclosure', href: 'javascript:alert(1)', title: 'evil' }),
        d: link({ rel: 'icon', href: 'https://example.org/logo.png' }),
      },
    });
    expect(list).toEqual([
      { key: 'a', name: 'notes.txt', contentType: 'text/plain', size: 16, blobId: 'b1', url: null },
      { key: 'b', name: 'Site plan.pdf', contentType: null, size: null, blobId: null, url: 'https://example.org/files/Site%20plan.pdf' },
      { key: 'c', name: 'evil', contentType: null, size: null, blobId: null, url: null },
    ]);
  });

  it('is empty for an event without links', () => {
    expect(eventAttachments({ links: null })).toEqual([]);
    expect(eventAttachments(null)).toEqual([]);
  });
});

describe('linksWithAttachmentChanges', () => {
  const other = link({ rel: 'describedby', href: 'https://example.org/agenda' });
  const file = link({ rel: 'enclosure', blobId: 'b1', title: 'notes.txt' });

  it('leaves the links out when nothing changed', () => {
    expect(linksWithAttachmentChanges({ x: other }, [], [])).toBeUndefined();
    expect(linksWithAttachmentChanges({ x: other }, ['gone'], [])).toBeUndefined();
  });

  it('removes a file and keeps every other link as it was', () => {
    expect(linksWithAttachmentChanges({ x: other, f: file }, ['f'], [])).toEqual({ x: other });
  });

  it('adds new files next to the links the event had', () => {
    const added = attachmentLink({ blobId: 'b2', size: 2048, type: 'application/pdf' }, 'plan.pdf');
    const next = linksWithAttachmentChanges({ x: other, f: file }, [], [added])!;
    expect(next.x).toBe(other);
    expect(next.f).toBe(file);
    const keys = Object.keys(next).filter((k) => k !== 'x' && k !== 'f');
    expect(keys).toHaveLength(1);
    expect(next[keys[0]]).toEqual({
      '@type': 'Link', blobId: 'b2', rel: 'enclosure', contentType: 'application/pdf', size: 2048, title: 'plan.pdf',
    });
  });

  it('clears the links when the last one goes', () => {
    expect(linksWithAttachmentChanges({ f: file }, ['f'], [])).toBeNull();
  });
});

describe('JMAPClient.supportsCalendarBlobLinks', () => {
  function client(supportedTypeNames?: string[]) {
    const c = new JMAPClient('https://jmap.example.com', 'user', 'pass');
    Object.assign(c, {
      accountId: 'account-1',
      session: {
        primaryAccounts: { 'urn:ietf:params:jmap:calendars': 'account-1' },
        accounts: {
          'account-1': {
            name: 'test', isPersonal: true,
            accountCapabilities: supportedTypeNames ? { 'urn:ietf:params:jmap:blob': { supportedTypeNames } } : {},
          },
        },
      },
    });
    return c;
  }

  it('is true on Stalwart 1.0, whose blob capability lists CalendarEvent', () => {
    expect(client(['Email', 'Thread', 'SieveScript', 'CalendarEvent', 'ContactCard']).supportsCalendarBlobLinks()).toBe(true);
  });

  it('is false on Stalwart 0.16, which drops blob links from events', () => {
    expect(client(['Email', 'Thread', 'SieveScript']).supportsCalendarBlobLinks()).toBe(false);
    expect(client().supportsCalendarBlobLinks()).toBe(false);
    expect(client(['CalendarEvent']).supportsCalendarBlobLinks('other')).toBe(false);
  });
});
