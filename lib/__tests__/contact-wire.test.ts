import { describe, it, expect } from 'vitest';
import { contactFromWire, contactToWire } from '../jmap/contact-wire';
import type { ContactCard } from '../jmap/types';

describe('contactToWire', () => {
  it('drops client-only fields, which ContactCard/set rejects', () => {
    const wire = contactToWire({
      name: { full: 'A' },
      originalId: 'x', accountId: 'a', accountName: 'n', isShared: true, localAccountId: 'l',
    }, 'create');
    expect(wire).toEqual({ name: { full: 'A' } });
  });

  it('writes the calendar URIs as RFC 9553 calendars and schedulingAddresses', () => {
    const wire = contactToWire({
      calendarUri: 'https://x.test/cal',
      freeBusyUri: 'https://x.test/fb',
      schedulingUri: 'mailto:a@x.test',
    }, 'create');
    expect(wire).toEqual({
      calendars: {
        cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://x.test/cal' },
        fb: { '@type': 'Calendar', kind: 'freeBusy', uri: 'https://x.test/fb' },
      },
      schedulingAddresses: { sched: { '@type': 'SchedulingAddress', uri: 'mailto:a@x.test' } },
    });
  });

  it('sends null for cleared fields on update, but omits them on create', () => {
    const cleared: Partial<ContactCard> = { nicknames: undefined, calendarUri: undefined, schedulingUri: undefined };
    expect(contactToWire(cleared, 'update')).toEqual({ nicknames: null, calendars: null, schedulingAddresses: null });
    expect(contactToWire(cleared, 'create')).toEqual({});
  });

  it('leaves calendar links alone when the update does not mention them', () => {
    expect(contactToWire({ keywords: { vip: true } }, 'update')).toEqual({ keywords: { vip: true } });
  });

  it('converts flat vCard addresses to components and SOURCE to a directory entry', () => {
    const wire = contactToWire({
      addresses: { a0: { street: 'Main St 1', locality: 'Town', country: 'DE', fullAddress: 'Main St 1, Town', contexts: { work: true } } },
      source: 'https://x.test/card.vcf',
    }, 'create');
    expect(wire.addresses).toEqual({
      a0: {
        components: [
          { kind: 'name', value: 'Main St 1' },
          { kind: 'locality', value: 'Town' },
          { kind: 'country', value: 'DE' },
        ],
        isOrdered: true,
        defaultSeparator: ', ',
        full: 'Main St 1, Town',
        contexts: { work: true },
      },
    });
    expect(wire.directories).toEqual({ source: { '@type': 'Directory', kind: 'entry', uri: 'https://x.test/card.vcf' } });
  });
});

describe('contactFromWire', () => {
  it('fills the flat URI fields from the server card', () => {
    const card = contactFromWire({
      id: 'c1',
      addressBookIds: {},
      calendars: { k: { kind: 'calendar', uri: 'https://x.test/cal' }, f: { kind: 'freeBusy', uri: 'https://x.test/fb' } },
      schedulingAddresses: { s: { uri: 'mailto:a@x.test' } },
      directories: { d: { kind: 'entry', uri: 'https://x.test/card.vcf' } },
    });
    expect(card).toMatchObject({
      calendarUri: 'https://x.test/cal',
      freeBusyUri: 'https://x.test/fb',
      schedulingUri: 'mailto:a@x.test',
      source: 'https://x.test/card.vcf',
    });
  });
});
