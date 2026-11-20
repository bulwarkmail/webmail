import { describe, it, expect } from 'vitest';
import {
  buildJMAPFilter,
  isFilterEmpty,
  activeFilterCount,
  splitSearchText,
  textConditions,
  textFilter,
  normalizePluginFilter,
  DEFAULT_SEARCH_FILTERS,
} from '../jmap/search-utils';
import type { SearchFilters } from '../jmap/search-utils';

type Filter = Record<string, unknown>;

describe('normalizePluginFilter', () => {
  // Plugin search.run and tab queries share this check: Stalwart 1.0 panics
  // on JMAP Metadata filter conditions.
  it('rejects JMAP Metadata conditions in a plugin search', () => {
    expect(() => normalizePluginFilter('search.run: query', {
      operator: 'AND',
      conditions: [{ from: 'a@example.com' }, { privateMetadataTextContains: 'x' }],
    })).toThrow('search.run: query may not filter on JMAP Metadata ("privateMetadataTextContains")');
    expect(normalizePluginFilter('search.run: query', { from: 'a@example.com' })).toEqual({ from: 'a@example.com' });
  });
});

/** Stalwart rejects a filter object with both `operator` and property keys. */
function expectNoMixedKeys(filter: Filter): void {
  if ('operator' in filter) {
    expect(Object.keys(filter).sort()).toEqual(['conditions', 'operator']);
    for (const c of filter.conditions as Filter[]) expectNoMixedKeys(c);
  } else {
    expect(filter).not.toHaveProperty('conditions');
  }
}

// ---------------------------------------------------------------------------
// A small model of Email/query text conditions on Stalwart's built-in index,
// so the tests can check what a filter finds on each version, not only its
// shape. It leaves out stemming and language detection.
// - 1.0 (store/src/search/document.rs `has_text`): a value wrapped in `"` or
//   `'` is an exact phrase (word positions exist for subject and body only;
//   address fields fall back to all words); a value ending in `*` is one
//   prefix over the rest, lower-cased and not split into words, at most 16
//   bytes, matching words of at most 16 bytes; anything else needs all its
//   words in the same field.
// - 0.16: no phrases and no prefixes; every value needs all its words in the
//   same field (a quoted one without stemming, which the model leaves out),
//   and `*` only separates words.
// - `text` is an OR over from, to, subject and body.
// ---------------------------------------------------------------------------
type Version = '0.16' | '1.0';
interface Message { id: string; from: string; to: string; subject: string; body: string }

const MESSAGES: Message[] = [
  { id: 'report', from: 'Anna Muster <anna@firma.de>', to: 'team@firma.de', subject: 'Draft: annual report 2024', body: 'The numbers are final.' },
  { id: 'shuffled', from: 'Ben <ben@firma.de>', to: 'team@firma.de', subject: 'Report on annual goals, 2024 draft', body: '' },
  { id: 'budget', from: 'Carla <carla@firma.de>', to: 'team@firma.de', subject: 'Project budget', body: 'Numbers for Q3.' },
  { id: 'board', from: 'Dieter <dieter@firma.de>', to: 'team@firma.de', subject: 'Protokoll', body: 'Die Geschäftsführung hat entschieden.' },
];

const wordsOf = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const byteLength = (value: string) => new TextEncoder().encode(value).length;

function fieldMatches(version: Version, value: string, field: string, hasPositions: boolean): boolean {
  const tokens = wordsOf(field);
  if (version === '1.0') {
    const exact = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
    if (exact) {
      const phrase = wordsOf(exact[1]);
      if (phrase.length === 0) return false;
      if (!hasPositions) return phrase.every((w) => tokens.includes(w));
      return tokens.some((_, i) => phrase.every((w, j) => tokens[i + j] === w));
    }
    if (value.endsWith('*')) {
      const prefix = value.slice(0, -1).trim().toLowerCase();
      if (!prefix || byteLength(prefix) > 16) return false;
      return tokens.some((t) => byteLength(t) <= 16 && t.startsWith(prefix));
    }
  }
  const words = wordsOf(value);
  return words.length > 0 && words.every((w) => tokens.includes(w));
}

function messageMatches(version: Version, filter: Filter, m: Message): boolean {
  if (filter.operator === 'AND') return (filter.conditions as Filter[]).every((c) => messageMatches(version, c, m));
  const entries = Object.entries(filter) as [string, string][];
  return entries.every(([key, value]) => {
    switch (key) {
      case 'text':
        return fieldMatches(version, value, m.from, false) || fieldMatches(version, value, m.to, false)
          || fieldMatches(version, value, m.subject, true) || fieldMatches(version, value, m.body, true);
      case 'from':
      case 'to':
        return fieldMatches(version, value, m[key], false);
      case 'subject':
      case 'body':
        return fieldMatches(version, value, m[key], true);
      default:
        throw new Error(`the model has no ${key} condition`);
    }
  });
}

const hits = (version: Version, filter: Filter) =>
  MESSAGES.filter((m) => messageMatches(version, filter, m)).map((m) => m.id);

// ---------------------------------------------------------------------------
// splitSearchText / textConditions / textFilter
// ---------------------------------------------------------------------------
describe('splitSearchText', () => {
  it('gives every quoted phrase a part of its own', () => {
    expect(splitSearchText('"annual report" 2024 "draft"')).toEqual(['"annual report"', '2024', '"draft"']);
  });

  it('keeps plain queries as one part, as typed', () => {
    expect(splitSearchText('project budget')).toEqual(['project budget']);
    expect(splitSearchText('anna@firma.de')).toEqual(['anna@firma.de']);
    expect(splitSearchText('Geschäftsführung')).toEqual(['Geschäftsführung']);
    expect(splitSearchText('  project   budget ')).toEqual(['project budget']);
  });

  it('gives every word ending in * a part of its own', () => {
    expect(splitSearchText('project budg*')).toEqual(['project', 'budg*']);
    expect(splitSearchText('"a b" c d*')).toEqual(['"a b"', 'c', 'd*']);
  });

  it('keeps the other words together in one part where the first of them was typed', () => {
    expect(splitSearchText('q3 "annual report" budget')).toEqual(['q3 budget', '"annual report"']);
    expect(splitSearchText('budg* "annual report" project')).toEqual(['budg*', '"annual report"', 'project']);
  });

  it('closes an unterminated quote at the end of the input', () => {
    expect(splitSearchText('"half typed')).toEqual(['"half typed"']);
    expect(splitSearchText('invoice "half typed')).toEqual(['invoice', '"half typed"']);
  });

  it('drops empty quotes and lone stars', () => {
    expect(splitSearchText('""')).toEqual([]);
    expect(splitSearchText('"  " budget')).toEqual(['budget']);
    expect(splitSearchText('*')).toEqual([]);
    expect(splitSearchText('budget * **')).toEqual(['budget']);
  });

  it('strips outer single quotes, which would make the words one phrase', () => {
    expect(splitSearchText("'annual' 2024 'draft'")).toEqual(["annual' 2024 'draft"]);
    expect(splitSearchText("'annual report'")).toEqual(['annual report']);
    expect(splitSearchText("''")).toEqual([]);
  });
});

describe('textConditions / textFilter', () => {
  it('makes one condition per part on the given property', () => {
    expect(textConditions('"annual report" 2024 "draft"')).toEqual([
      { text: '"annual report"' }, { text: '2024' }, { text: '"draft"' },
    ]);
    expect(textConditions('anna mül*', 'from')).toEqual([{ from: 'anna' }, { from: 'mül*' }]);
  });

  it('sends the input as before when no part is left', () => {
    expect(textConditions('""')).toEqual([{ text: '""' }]);
    expect(textConditions(' * ')).toEqual([{ text: '*' }]);
  });

  it('returns a single condition as is and ANDs several', () => {
    expect(textFilter('project budget')).toEqual({ text: 'project budget' });
    expect(textFilter('"annual report" 2024')).toEqual({
      operator: 'AND',
      conditions: [{ text: '"annual report"' }, { text: '2024' }],
    });
  });
});

describe('text search results', () => {
  it('finds "annual report" 2024 "draft" on Stalwart 1.0, where the joined value was one phrase', () => {
    expect(hits('1.0', { text: '"annual report" 2024 "draft"' })).toEqual([]);
    expect(hits('1.0', textFilter('"annual report" 2024 "draft"'))).toEqual(['report']);
  });

  it('keeps the 0.16 hits for "annual report" 2024 "draft": an AND of the words', () => {
    expect(hits('0.16', { text: '"annual report" 2024 "draft"' })).toEqual(['report', 'shuffled']);
    expect(hits('0.16', textFilter('"annual report" 2024 "draft"'))).toEqual(['report', 'shuffled']);
  });

  it('finds project budg* on Stalwart 1.0 and changes nothing on 0.16', () => {
    expect(hits('1.0', { text: 'project budg*' })).toEqual([]);
    expect(hits('1.0', textFilter('project budg*'))).toEqual(['budget']);
    expect(hits('0.16', { text: 'project budg*' })).toEqual([]);
    expect(hits('0.16', textFilter('project budg*'))).toEqual([]);
  });

  it('sends plain queries unchanged, with the same hits on 0.16 and 1.0', () => {
    const plain: Array<[string, string[]]> = [
      ['project budget', ['budget']],
      ['anna@firma.de', ['report']],
      ['Geschäftsführung', ['board']],
    ];
    for (const [query, expected] of plain) {
      expect(textFilter(query)).toEqual({ text: query });
      expect(hits('0.16', textFilter(query))).toEqual(expected);
      expect(hits('1.0', textFilter(query))).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// buildJMAPFilter
// ---------------------------------------------------------------------------
describe('buildJMAPFilter', () => {
  const emptyFilters: SearchFilters = { ...DEFAULT_SEARCH_FILTERS };

  // -- text query ----------------------------------------------------------
  describe('text query', () => {
    it('builds a text filter from textQuery alone, as typed', () => {
      const result = buildJMAPFilter('pri', emptyFilters);
      expect(result).toEqual({ text: 'pri' });
    });

    it('keeps a multi-word query as one text condition', () => {
      const result = buildJMAPFilter('hello world', emptyFilters);
      expect(result).toEqual({ text: 'hello world' });
    });

    it('returns empty object when no query and no filters', () => {
      const result = buildJMAPFilter('', emptyFilters);
      expect(result).toEqual({});
    });

    it('keeps a lone phrase as one condition', () => {
      expect(buildJMAPFilter('"annual report"', emptyFilters)).toEqual({ text: '"annual report"' });
    });

    it('ANDs quoted phrases and prefixes as separate conditions, next to inMailbox', () => {
      const result = buildJMAPFilter('"annual report" 2024 budg*', emptyFilters, 'inbox-1');
      expect(result).toEqual({
        operator: 'AND',
        conditions: [
          { text: '"annual report"' },
          { text: '2024' },
          { text: 'budg*' },
          { inMailbox: 'inbox-1' },
        ],
      });
      expectNoMixedKeys(result);
    });

    it('splits the from, to, subject and body fields the same way', () => {
      const filters: SearchFilters = {
        ...emptyFilters,
        from: 'anna mül*',
        to: 'team@firma.de',
        subject: '"Q3 report" draft',
        body: "'annual report'",
      };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({
        operator: 'AND',
        conditions: [
          { from: 'anna' },
          { from: 'mül*' },
          { to: 'team@firma.de' },
          { subject: '"Q3 report"' },
          { subject: 'draft' },
          { body: 'annual report' },
        ],
      });
      expectNoMixedKeys(result);
    });
  });

  // -- individual field filters -------------------------------------------
  describe('individual field filters', () => {
    it('builds a from filter (no wildcard)', () => {
      const filters: SearchFilters = { ...emptyFilters, from: 'alice' };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ from: 'alice' });
    });

    it('builds a to filter (no wildcard)', () => {
      const filters: SearchFilters = { ...emptyFilters, to: 'bob@example.com' };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ to: 'bob@example.com' });
    });

    it('builds a subject filter (no wildcard)', () => {
      const filters: SearchFilters = { ...emptyFilters, subject: 'meeting' };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ subject: 'meeting' });
    });

    it('builds a body filter (no wildcard)', () => {
      const filters: SearchFilters = { ...emptyFilters, body: 'payment' };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ body: 'payment' });
    });
  });

  // -- boolean / keyword filters ------------------------------------------
  describe('boolean and keyword filters', () => {
    it('adds hasAttachment: true', () => {
      const filters: SearchFilters = { ...emptyFilters, hasAttachment: true };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ hasAttachment: true });
    });

    it('adds hasAttachment: false', () => {
      const filters: SearchFilters = { ...emptyFilters, hasAttachment: false };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ hasAttachment: false });
    });

    it('adds notKeyword $seen for isUnread=true', () => {
      const filters: SearchFilters = { ...emptyFilters, isUnread: true };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ notKeyword: '$seen' });
    });

    it('adds hasKeyword $seen for isUnread=false', () => {
      const filters: SearchFilters = { ...emptyFilters, isUnread: false };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ hasKeyword: '$seen' });
    });

    it('adds hasKeyword $flagged for isStarred=true', () => {
      const filters: SearchFilters = { ...emptyFilters, isStarred: true };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ hasKeyword: '$flagged' });
    });

    it('adds notKeyword $flagged for isStarred=false', () => {
      const filters: SearchFilters = { ...emptyFilters, isStarred: false };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({ notKeyword: '$flagged' });
    });
  });

  // -- date filters -------------------------------------------------------
  describe('date filters', () => {
    it('adds after condition for dateAfter', () => {
      const filters: SearchFilters = { ...emptyFilters, dateAfter: '2024-06-01' };
      const result = buildJMAPFilter('', filters);
      expect(result).toHaveProperty('after');
      expect(new Date(result.after as string).toISOString()).toContain('2024-06-01');
    });

    it('adds before condition for dateBefore (end of day)', () => {
      const filters: SearchFilters = { ...emptyFilters, dateBefore: '2024-12-31' };
      const result = buildJMAPFilter('', filters);
      expect(result).toHaveProperty('before');
      const d = new Date(result.before as string);
      expect(d.getHours()).toBe(23);
      expect(d.getMinutes()).toBe(59);
    });

    it('ignores invalid dateAfter', () => {
      const filters: SearchFilters = { ...emptyFilters, dateAfter: 'not-a-date' };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({});
    });

    it('ignores invalid dateBefore', () => {
      const filters: SearchFilters = { ...emptyFilters, dateBefore: 'nope' };
      const result = buildJMAPFilter('', filters);
      expect(result).toEqual({});
    });
  });

  // -- mailbox filter ------------------------------------------------------
  describe('mailbox filter', () => {
    it('returns inMailbox filter when only mailboxId provided', () => {
      const result = buildJMAPFilter('', emptyFilters, 'inbox-1');
      expect(result).toEqual({ inMailbox: 'inbox-1' });
    });

    it('wraps in AND when mailboxId combined with text query', () => {
      const result = buildJMAPFilter('pri', emptyFilters, 'inbox-1');
      expect(result).toEqual({
        operator: 'AND',
        conditions: [
          { text: 'pri' },
          { inMailbox: 'inbox-1' },
        ],
      });
    });
  });

  // -- combinations --------------------------------------------------------
  describe('combined filters', () => {
    it('ANDs text query with from filter', () => {
      const filters: SearchFilters = { ...emptyFilters, from: 'alice' };
      const result = buildJMAPFilter('urgent', filters);
      expect(result).toEqual({
        operator: 'AND',
        conditions: [
          { text: 'urgent' },
          { from: 'alice' },
        ],
      });
    });

    it('ANDs text query, from, subject, hasAttachment, and mailbox', () => {
      const filters: SearchFilters = {
        ...emptyFilters,
        from: 'ceo@corp.com',
        subject: 'quarterly',
        hasAttachment: true,
      };
      const result = buildJMAPFilter('report', filters, 'mb-42');
      expect(result).toEqual({
        operator: 'AND',
        conditions: [
          { text: 'report' },
          { from: 'ceo@corp.com' },
          { subject: 'quarterly' },
          { hasAttachment: true },
          { inMailbox: 'mb-42' },
        ],
      });
    });

    it('ANDs all possible filters at once', () => {
      const filters: SearchFilters = {
        from: 'alice',
        to: 'bob',
        subject: 'invoice',
        body: 'payment',
        hasAttachment: true,
        dateAfter: '2024-01-01',
        dateBefore: '2024-12-31',
        isUnread: true,
        isStarred: true,
        minSizeKb: '',
        maxSizeKb: '',
        untagged: false,
      };
      const result = buildJMAPFilter('money', filters, 'mb-1') as {
        operator: string;
        conditions: Record<string, unknown>[];
      };
      expect(result.operator).toBe('AND');
      expect(result.conditions).toContainEqual({ text: 'money' });
      expect(result.conditions).toContainEqual({ from: 'alice' });
      expect(result.conditions).toContainEqual({ to: 'bob' });
      expect(result.conditions).toContainEqual({ subject: 'invoice' });
      expect(result.conditions).toContainEqual({ body: 'payment' });
      expect(result.conditions).toContainEqual({ hasAttachment: true });
      expect(result.conditions).toContainEqual({ notKeyword: '$seen' });
      expect(result.conditions).toContainEqual({ hasKeyword: '$flagged' });
      expect(result.conditions).toContainEqual({ inMailbox: 'mb-1' });
      // dateAfter and dateBefore produce after/before ISO strings
      expect(result.conditions.some(c => 'after' in c)).toBe(true);
      expect(result.conditions.some(c => 'before' in c)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// isFilterEmpty
// ---------------------------------------------------------------------------
describe('isFilterEmpty', () => {
  it('returns true for default filters', () => {
    expect(isFilterEmpty(DEFAULT_SEARCH_FILTERS)).toBe(true);
  });

  it('returns false when from is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, from: 'alice' })).toBe(false);
  });

  it('returns false when to is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, to: 'bob' })).toBe(false);
  });

  it('returns false when subject is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, subject: 'hello' })).toBe(false);
  });

  it('returns false when body is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, body: 'world' })).toBe(false);
  });

  it('returns false when hasAttachment is true', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, hasAttachment: true })).toBe(false);
  });

  it('returns false when hasAttachment is false', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, hasAttachment: false })).toBe(false);
  });

  it('returns false when dateAfter is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, dateAfter: '2024-01-01' })).toBe(false);
  });

  it('returns false when dateBefore is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, dateBefore: '2024-12-31' })).toBe(false);
  });

  it('returns false when isUnread is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, isUnread: true })).toBe(false);
  });

  it('returns false when isStarred is set', () => {
    expect(isFilterEmpty({ ...DEFAULT_SEARCH_FILTERS, isStarred: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// activeFilterCount
// ---------------------------------------------------------------------------
describe('activeFilterCount', () => {
  it('returns 0 for default filters', () => {
    expect(activeFilterCount(DEFAULT_SEARCH_FILTERS)).toBe(0);
  });

  it('counts each active text field', () => {
    expect(activeFilterCount({ ...DEFAULT_SEARCH_FILTERS, from: 'a', to: 'b' })).toBe(2);
  });

  it('counts boolean filters', () => {
    expect(activeFilterCount({
      ...DEFAULT_SEARCH_FILTERS,
      hasAttachment: true,
      isUnread: false,
      isStarred: true,
    })).toBe(3);
  });

  it('counts date filters', () => {
    expect(activeFilterCount({
      ...DEFAULT_SEARCH_FILTERS,
      dateAfter: '2024-01-01',
      dateBefore: '2024-12-31',
    })).toBe(2);
  });

  it('counts all 9 filters when all active', () => {
    expect(activeFilterCount({
      from: 'a',
      to: 'b',
      subject: 'c',
      body: 'd',
      hasAttachment: true,
      dateAfter: '2024-01-01',
      dateBefore: '2024-12-31',
      isUnread: true,
      isStarred: true,
      minSizeKb: '',
      maxSizeKb: '',
      untagged: false,
    })).toBe(9);
  });
});

describe('untagged filter', () => {
  const untagged: SearchFilters = { ...DEFAULT_SEARCH_FILTERS, untagged: true };
  const notTagged = [
    { notKeyword: '$label:work' },
    { notKeyword: '$color:work' },
    { notKeyword: '$label:red' },
    { notKeyword: '$color:red' },
  ];

  it('leaves out every known tag under both prefixes, ANDed with the rest', () => {
    expect(buildJMAPFilter('report', { ...untagged, isUnread: true }, 'mb-1', ['work', 'red'])).toEqual({
      operator: 'AND',
      conditions: [{ text: 'report' }, { notKeyword: '$seen' }, ...notTagged, { inMailbox: 'mb-1' }],
    });
  });

  it('is the AND of the tag conditions alone', () => {
    expect(buildJMAPFilter('', untagged, undefined, ['work', 'red'])).toEqual({ operator: 'AND', conditions: notTagged });
  });

  it('adds nothing without known tags', () => {
    expect(buildJMAPFilter('', untagged, 'mb-1', [])).toEqual({ inMailbox: 'mb-1' });
    expect(buildJMAPFilter('', untagged)).toEqual({});
    expect(buildJMAPFilter('report', untagged, undefined, [])).toEqual({ text: 'report' });
  });

  it('adds nothing when off, even with known tags', () => {
    expect(buildJMAPFilter('', DEFAULT_SEARCH_FILTERS, 'mb-1', ['work'])).toEqual({ inMailbox: 'mb-1' });
  });

  it('counts as an active filter', () => {
    expect(isFilterEmpty(untagged)).toBe(false);
    expect(activeFilterCount(untagged)).toBe(1);
    expect(activeFilterCount({ ...untagged, isStarred: true })).toBe(2);
  });
});

describe('size filters', () => {
  const base = { ...DEFAULT_SEARCH_FILTERS };

  it('converts KB bounds to minSize / maxSize byte conditions', () => {
    expect(buildJMAPFilter('', { ...base, minSizeKb: '100', maxSizeKb: '2048' })).toEqual({
      operator: 'AND',
      conditions: [{ minSize: 102400 }, { maxSize: 2097152 }],
    });
  });

  it('ignores empty, zero and non-numeric sizes', () => {
    expect(buildJMAPFilter('', { ...base, minSizeKb: '0', maxSizeKb: 'abc' })).toEqual({});
    expect(isFilterEmpty({ ...base, minSizeKb: '0', maxSizeKb: '' })).toBe(true);
    expect(isFilterEmpty({ ...base, minSizeKb: '5' })).toBe(false);
    expect(activeFilterCount({ ...base, minSizeKb: '5', maxSizeKb: '9' })).toBe(2);
  });
});
