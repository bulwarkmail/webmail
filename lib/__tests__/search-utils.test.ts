import { describe, it, expect } from 'vitest';
import {
  buildJMAPFilter,
  isFilterEmpty,
  activeFilterCount,
  DEFAULT_SEARCH_FILTERS,
} from '../jmap/search-utils';
import type { SearchFilters } from '../jmap/search-utils';

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
    })).toBe(9);
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
