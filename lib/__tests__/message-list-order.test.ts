import { describe, it, expect } from 'vitest';
import {
  buildEmailSort,
  compareEmails,
  detectPreset,
  hasKeywordLevels,
  isDefaultOrder,
  keywordFirst,
  levelKeyword,
  orderForMailbox,
  orderKeywords,
  presetLevels,
  sanitizeSortLevels,
  MAX_SORT_LEVELS,
  type SortLevel,
} from '../message-list-order';
import type { Email } from '../jmap/types';

const UNREAD_FIRST: SortLevel[] = [{ criterion: 'unread', direction: 'desc' }];
const STARRED_FIRST: SortLevel[] = [{ criterion: 'starred', direction: 'desc' }];

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    threadId: 't',
    mailboxIds: {},
    keywords: {},
    size: 100,
    receivedAt: '2026-01-01T00:00:00Z',
    hasAttachment: false,
    ...overrides,
  };
}

describe('sanitizeSortLevels', () => {
  it('returns an empty list for anything that is not an array', () => {
    expect(sanitizeSortLevels(undefined)).toEqual([]);
    expect(sanitizeSortLevels('unread')).toEqual([]);
    expect(sanitizeSortLevels({ criterion: 'unread' })).toEqual([]);
  });

  it('drops unknown criteria, defaults a missing direction and caps the list', () => {
    const levels = sanitizeSortLevels([
      { criterion: 'unread' },
      { criterion: 'importance', direction: 'desc' },
      { criterion: 'from', direction: 'sideways' },
      { criterion: 'size', direction: 'asc' },
      { criterion: 'subject', direction: 'asc' },
    ]);
    expect(levels).toEqual([
      { criterion: 'unread', direction: 'desc' },
      { criterion: 'from', direction: 'asc' },
      { criterion: 'size', direction: 'asc' },
    ]);
    expect(levels).toHaveLength(MAX_SORT_LEVELS);
  });

  it('drops a tag level without a tag id and duplicate criteria', () => {
    expect(sanitizeSortLevels([
      { criterion: 'tag', direction: 'desc' },
      { criterion: 'tag', direction: 'desc', tagId: 'red' },
      { criterion: 'tag', direction: 'desc', tagId: 'red' },
      { criterion: 'tag', direction: 'asc', tagId: 'blue' },
      { criterion: 'unread', direction: 'desc' },
      { criterion: 'unread', direction: 'asc' },
    ])).toEqual([
      { criterion: 'tag', direction: 'desc', tagId: 'red' },
      { criterion: 'tag', direction: 'asc', tagId: 'blue' },
      { criterion: 'unread', direction: 'desc' },
    ]);
  });
});

describe('keyword semantics', () => {
  it('maps the boolean criteria onto JMAP keywords', () => {
    expect(levelKeyword({ criterion: 'unread', direction: 'desc' })).toBe('$seen');
    expect(levelKeyword({ criterion: 'starred', direction: 'desc' })).toBe('$flagged');
    expect(levelKeyword({ criterion: 'tag', direction: 'desc', tagId: 'red' })).toBe('$label:red');
    expect(levelKeyword({ criterion: 'receivedAt', direction: 'desc' })).toBeNull();
  });

  it('lists the keywords an order sorts on', () => {
    expect(orderKeywords([
      { criterion: 'unread', direction: 'desc' },
      { criterion: 'from', direction: 'asc' },
      { criterion: 'tag', direction: 'desc', tagId: 'red' },
    ])).toEqual(['$seen', '$label:red']);
    expect(orderKeywords([])).toEqual([]);
  });

  it('"unread first" means messages WITHOUT $seen first', () => {
    expect(keywordFirst({ criterion: 'unread', direction: 'desc' })).toBe(false);
    expect(keywordFirst({ criterion: 'unread', direction: 'asc' })).toBe(true);
    expect(keywordFirst({ criterion: 'starred', direction: 'desc' })).toBe(true);
    expect(keywordFirst({ criterion: 'tag', direction: 'desc', tagId: 'x' })).toBe(true);
  });

  it('knows when a keyword comparator is needed', () => {
    expect(hasKeywordLevels([])).toBe(false);
    expect(hasKeywordLevels([], true)).toBe(true);
    expect(hasKeywordLevels([{ criterion: 'size', direction: 'desc' }])).toBe(false);
    expect(hasKeywordLevels(UNREAD_FIRST)).toBe(true);
  });
});

describe('buildEmailSort', () => {
  it('is plain newest-first with no levels', () => {
    expect(buildEmailSort([])).toEqual([{ property: 'receivedAt', isAscending: false }]);
  });

  it('follows the RFC 8621 polarity by default: has-keyword first is descending', () => {
    // RFC example: {someInThreadHaveKeyword, $flagged, isAscending: false} sorts flagged first.
    expect(buildEmailSort(STARRED_FIRST)).toEqual([
      { property: 'hasKeyword', keyword: '$flagged', isAscending: false },
      { property: 'receivedAt', isAscending: false },
    ]);
    // Unread first = $seen absent first = $seen ascending.
    expect(buildEmailSort(UNREAD_FIRST)).toEqual([
      { property: 'hasKeyword', keyword: '$seen', isAscending: true },
      { property: 'receivedAt', isAscending: false },
    ]);
  });

  it('flips only the keyword comparators for an inverted server (Stalwart 0.16.8)', () => {
    expect(buildEmailSort(UNREAD_FIRST, { polarity: 'inverted' })).toEqual([
      { property: 'hasKeyword', keyword: '$seen', isAscending: false },
      { property: 'receivedAt', isAscending: false },
    ]);
    expect(buildEmailSort([{ criterion: 'size', direction: 'asc' }], { polarity: 'inverted' })).toEqual([
      { property: 'size', isAscending: true },
      { property: 'receivedAt', isAscending: false },
    ]);
  });

  it('keeps pinned-first ahead of the configured order', () => {
    expect(buildEmailSort(UNREAD_FIRST, { pinnedFirst: true })).toEqual([
      { property: 'hasKeyword', keyword: '$pinned', isAscending: false },
      { property: 'hasKeyword', keyword: '$seen', isAscending: true },
      { property: 'receivedAt', isAscending: false },
    ]);
    expect(buildEmailSort([], { pinnedFirst: true, polarity: 'inverted' })[0]).toEqual(
      { property: 'hasKeyword', keyword: '$pinned', isAscending: true },
    );
  });

  it('drops keyword comparators when the server cannot sort on them', () => {
    expect(buildEmailSort(UNREAD_FIRST, { pinnedFirst: true, keywordSortSupported: false })).toEqual([
      { property: 'receivedAt', isAscending: false },
    ]);
  });

  it('does not add a second receivedAt comparator when the user ordered by date', () => {
    expect(buildEmailSort([
      { criterion: 'from', direction: 'asc' },
      { criterion: 'receivedAt', direction: 'asc' },
    ])).toEqual([
      { property: 'from', isAscending: true },
      { property: 'receivedAt', isAscending: true },
    ]);
  });
});

describe('compareEmails', () => {
  const unreadOld = makeEmail({ id: 'unread-old', receivedAt: '2026-01-01T00:00:00Z' });
  const unreadNew = makeEmail({ id: 'unread-new', receivedAt: '2026-01-03T00:00:00Z' });
  const readNewest = makeEmail({ id: 'read-newest', receivedAt: '2026-01-05T00:00:00Z', keywords: { $seen: true } });
  const readMid = makeEmail({ id: 'read-mid', receivedAt: '2026-01-02T00:00:00Z', keywords: { $seen: true } });

  it('is newest-first with no levels', () => {
    const sorted = [unreadOld, readNewest, unreadNew, readMid].sort(compareEmails([]));
    expect(sorted.map(e => e.id)).toEqual(['read-newest', 'unread-new', 'read-mid', 'unread-old']);
  });

  it('puts unread first, each group newest first', () => {
    const sorted = [unreadOld, readNewest, unreadNew, readMid].sort(compareEmails(UNREAD_FIRST));
    expect(sorted.map(e => e.id)).toEqual(['unread-new', 'unread-old', 'read-newest', 'read-mid']);
  });

  it('honours "read first"', () => {
    const sorted = [unreadOld, readNewest, unreadNew, readMid].sort(compareEmails([{ criterion: 'unread', direction: 'asc' }]));
    expect(sorted.map(e => e.id)).toEqual(['read-newest', 'read-mid', 'unread-new', 'unread-old']);
  });

  it('keeps pinned mail on top of any order', () => {
    const pinnedRead = makeEmail({ id: 'pinned', receivedAt: '2025-01-01T00:00:00Z', keywords: { $seen: true, $pinned: true } });
    const sorted = [unreadNew, pinnedRead, readNewest].sort(compareEmails(UNREAD_FIRST, { pinnedFirst: true }));
    expect(sorted.map(e => e.id)).toEqual(['pinned', 'unread-new', 'read-newest']);
  });

  it('sorts by starred, tag, sender, subject and size', () => {
    const a = makeEmail({ id: 'a', size: 10, from: [{ name: 'Zoe', email: 'z@x' }], subject: 'Re: beta', keywords: { '$label:red': true } });
    const b = makeEmail({ id: 'b', size: 30, from: [{ name: '', email: 'alpha@x' }], subject: 'Fwd: alpha', keywords: { $flagged: true } });
    const c = makeEmail({ id: 'c', size: 20, from: [{ name: 'Mia', email: 'm@x' }], subject: 'gamma' });

    expect([a, b, c].sort(compareEmails(STARRED_FIRST)).map(e => e.id)).toEqual(['b', 'a', 'c']);
    expect([a, b, c].sort(compareEmails([{ criterion: 'tag', direction: 'desc', tagId: 'red' }])).map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect([a, b, c].sort(compareEmails([{ criterion: 'from', direction: 'asc' }])).map(e => e.id)).toEqual(['b', 'c', 'a']);
    expect([a, b, c].sort(compareEmails([{ criterion: 'subject', direction: 'asc' }])).map(e => e.id)).toEqual(['b', 'a', 'c']);
    expect([a, b, c].sort(compareEmails([{ criterion: 'size', direction: 'desc' }])).map(e => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('applies levels in priority order', () => {
    const starredOld = makeEmail({ id: 'starred-old', receivedAt: '2026-01-01T00:00:00Z', keywords: { $flagged: true, $seen: true } });
    const sorted = [readNewest, starredOld, unreadNew].sort(compareEmails([
      { criterion: 'unread', direction: 'desc' },
      { criterion: 'starred', direction: 'desc' },
    ]));
    expect(sorted.map(e => e.id)).toEqual(['unread-new', 'starred-old', 'read-newest']);
  });
});

describe('orderForMailbox', () => {
  it('applies to the Inbox only by default', () => {
    expect(orderForMailbox(UNREAD_FIRST, 'inbox', 'inbox')).toEqual(UNREAD_FIRST);
    expect(orderForMailbox(UNREAD_FIRST, 'inbox', 'archive')).toEqual([]);
    expect(orderForMailbox(UNREAD_FIRST, 'inbox', null)).toEqual([]);
  });

  it('applies everywhere under the all-folders scope', () => {
    expect(orderForMailbox(UNREAD_FIRST, 'all', 'archive')).toEqual(UNREAD_FIRST);
    expect(orderForMailbox(UNREAD_FIRST, 'all', undefined)).toEqual(UNREAD_FIRST);
    expect(orderForMailbox([], 'all', 'inbox')).toEqual([]);
  });
});

describe('presets', () => {
  it('round-trips the simple presets', () => {
    expect(detectPreset(presetLevels('chronological'))).toBe('chronological');
    expect(detectPreset(presetLevels('unread_first'))).toBe('unread_first');
    expect(detectPreset(presetLevels('starred_first'))).toBe('starred_first');
    expect(detectPreset(presetLevels('tagged_first', 'red'))).toBe('tagged_first');
    expect(presetLevels('tagged_first')).toEqual([]);
  });

  it('treats an explicit trailing newest-first level as part of the preset', () => {
    expect(detectPreset([...UNREAD_FIRST, { criterion: 'receivedAt', direction: 'desc' }])).toBe('unread_first');
    expect(isDefaultOrder([{ criterion: 'receivedAt', direction: 'desc' }])).toBe(true);
  });

  it('reports anything else as custom', () => {
    expect(detectPreset([{ criterion: 'unread', direction: 'asc' }])).toBe('custom');
    expect(detectPreset([...UNREAD_FIRST, ...STARRED_FIRST])).toBe('custom');
    expect(detectPreset([{ criterion: 'size', direction: 'desc' }])).toBe('custom');
  });
});
