import { describe, it, expect, beforeEach } from 'vitest';
import { useEmailStore } from '../email-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

function makeEmail(id: string, threadId = `thread-${id}`) {
  return {
    id,
    threadId,
    mailboxIds: { inbox: true },
    keywords: {},
    size: 100,
    receivedAt: new Date().toISOString(),
    from: [{ name: 'Test', email: 'test@example.com' }],
    to: [{ name: 'User', email: 'user@example.com' }],
    subject: `Email ${id}`,
    preview: 'preview',
    hasAttachment: false,
    textBody: [],
    htmlBody: [],
    bodyValues: {},
  };
}

describe('email-store selection', () => {
  beforeEach(() => {
    useEmailStore.setState({
      emails: [makeEmail('a'), makeEmail('b'), makeEmail('c'), makeEmail('d'), makeEmail('e')],
      selectedEmailKeys: new Set(),
      lastSelectedEmailKey: null,
      selectedEmail: null,
      listRows: null,
    });
  });

  describe('a different search', () => {
    const ticked = () => useEmailStore.getState().selectedEmailKeys.size;
    beforeEach(() => {
      useEmailStore.setState({ searchQuery: 'beacon', searchFilters: { ...DEFAULT_SEARCH_FILTERS } });
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      expect(ticked()).toBe(1);
    });

    it('drops the ticks when the query changes, also to nothing', () => {
      useEmailStore.getState().setSearchQuery('');
      expect(ticked()).toBe(0);
      expect(useEmailStore.getState().lastSelectedEmailKey).toBeNull();
    });

    it('keeps them when the same query is set again', () => {
      useEmailStore.getState().setSearchQuery('beacon');
      expect(ticked()).toBe(1);
    });

    it('drops them when a search runs for another query, before its results land', () => {
      const pending = new Promise<never>(() => {});
      void useEmailStore.getState().searchEmails({ searchEmails: () => pending } as never, 'rollback');
      expect(ticked()).toBe(0);
    });

    it('keeps them when the same search runs again', () => {
      const pending = new Promise<never>(() => {});
      void useEmailStore.getState().searchEmails({ searchEmails: () => pending } as never, 'beacon');
      expect(ticked()).toBe(1);
    });

    it('drops them when a filter changes or the filters are cleared', () => {
      useEmailStore.getState().setSearchFilters({ isUnread: true });
      expect(ticked()).toBe(0);
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      useEmailStore.getState().clearSearchFilters();
      expect(ticked()).toBe(0);
    });

    it('keeps them when clearing filters that were not set', () => {
      useEmailStore.getState().clearSearchFilters();
      expect(ticked()).toBe(1);
    });
  });

  describe('toggleEmailSelection', () => {
    it('should add email to selection', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      expect(useEmailStore.getState().selectedEmailKeys.has('b')).toBe(true);
      expect(useEmailStore.getState().lastSelectedEmailKey).toBe('b');
    });

    it('should remove email from selection when toggled again', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      expect(useEmailStore.getState().selectedEmailKeys.has('b')).toBe(false);
    });

    it('should support selecting multiple emails', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'a' });
      useEmailStore.getState().toggleEmailSelection({ id: 'c' });
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('a')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.size).toBe(2);
    });
  });

  describe('selectRangeEmails', () => {
    it('should select range from last selected to target (forward)', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'b' }); // anchor at index 1
      useEmailStore.getState().selectRangeEmails({ id: 'd' }); // target at index 3
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.has('d')).toBe(true);
      expect(ids.size).toBe(3);
    });

    it('should select range backward', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'd' }); // anchor at index 3
      useEmailStore.getState().selectRangeEmails({ id: 'b' }); // target at index 1
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.has('d')).toBe(true);
      expect(ids.size).toBe(3);
    });

    it('should use first email as anchor when no previous selection', () => {
      useEmailStore.getState().selectRangeEmails({ id: 'c' }); // no anchor → uses first email 'a'
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('a')).toBe(true);
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.size).toBe(3);
    });

    it('should add to existing selection', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'a' });
      useEmailStore.getState().toggleEmailSelection({ id: 'b' }); // anchor now at 'b'
      useEmailStore.getState().selectRangeEmails({ id: 'd' });
      const ids = useEmailStore.getState().selectedEmailKeys;
      // 'a' still selected, plus b-d range
      expect(ids.has('a')).toBe(true);
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.has('d')).toBe(true);
      expect(ids.size).toBe(4);
    });

    it('should handle single-item range', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'c' });
      useEmailStore.getState().selectRangeEmails({ id: 'c' });
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('c')).toBe(true);
      expect(ids.size).toBe(1);
    });
  });

  // #1230: the list shows a thread once, at its newest message. A range used
  // to walk the flat date order, so a thread whose older message fell between
  // the two ends got pulled in although its row was outside the range.
  describe('selectRangeEmails over list rows', () => {
    // Flat date order: t3 17:00, A 16:45, B 16:00, C 15:15, t2 15:00, D 14:30, t1 13:00.
    const flat = ['t3', 'A', 'B', 'C', 't2', 'D', 't1'];
    const rows = [
      { key: 't3', members: ['t3', 't2', 't1'] },
      { key: 'A', members: ['A'] },
      { key: 'B', members: ['B'] },
      { key: 'C', members: ['C'] },
      { key: 'D', members: ['D'] },
    ];

    beforeEach(() => {
      useEmailStore.setState({
        emails: flat.map((id) => makeEmail(id, id.startsWith('t') ? 'thread-t' : `thread-${id}`)),
        listRows: rows,
      });
    });

    it('selects the rows between the two ends, not a thread dated between them', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'D' });
      useEmailStore.getState().selectRangeEmails({ id: 'B' });
      expect([...useEmailStore.getState().selectedEmailKeys].sort()).toEqual(['B', 'C', 'D']);
    });

    it('selects every message of a thread whose row is in the range', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'B' });
      useEmailStore.getState().selectRangeEmails({ id: 't3' });
      expect([...useEmailStore.getState().selectedEmailKeys].sort()).toEqual(['A', 'B', 't1', 't2', 't3']);
    });

    it('finds a thread row from an older message of that thread', () => {
      useEmailStore.setState({ lastSelectedEmailKey: 't1' });
      useEmailStore.getState().selectRangeEmails({ id: 'A' });
      expect([...useEmailStore.getState().selectedEmailKeys].sort()).toEqual(['A', 't1', 't2', 't3']);
    });
  });

  // #992: Shift+Arrow grows the selection from the open message one row at a
  // time and shrinks it again when the direction reverses.
  describe('extendSelection', () => {
    const keys = () => [...useEmailStore.getState().selectedEmailKeys].sort();

    beforeEach(() => {
      // Opening a message makes it the anchor, as selectEmail does.
      useEmailStore.setState({ lastSelectedEmailKey: 'b', selectionFocus: null });
    });

    it('selects the open message and the next one on the first press', () => {
      useEmailStore.getState().extendSelection(1);
      expect(keys()).toEqual(['b', 'c']);
    });

    it('keeps growing in the same direction', () => {
      useEmailStore.getState().extendSelection(1);
      useEmailStore.getState().extendSelection(1);
      expect(keys()).toEqual(['b', 'c', 'd']);
    });

    it('shrinks back when the direction reverses', () => {
      useEmailStore.getState().extendSelection(1);
      useEmailStore.getState().extendSelection(1);
      useEmailStore.getState().extendSelection(-1);
      expect(keys()).toEqual(['b', 'c']);
    });

    it('crosses the anchor and grows the other way', () => {
      useEmailStore.getState().extendSelection(1);
      useEmailStore.getState().extendSelection(-1);
      useEmailStore.getState().extendSelection(-1);
      expect(keys()).toEqual(['a', 'b']);
    });

    it('stops at the end of the list', () => {
      for (let i = 0; i < 10; i++) useEmailStore.getState().extendSelection(1);
      expect(keys()).toEqual(['b', 'c', 'd', 'e']);
    });

    it('continues a shift-click range', () => {
      useEmailStore.getState().selectRangeEmails({ id: 'd' });
      useEmailStore.getState().extendSelection(-1);
      expect(keys()).toEqual(['b', 'c']);
    });

    it('walks list rows, taking a whole thread with its row', () => {
      useEmailStore.setState({
        emails: ['t2', 'x', 't1', 'y'].map((id) => makeEmail(id, id.startsWith('t') ? 'thread-t' : `thread-${id}`)),
        listRows: [
          { key: 'x', members: ['x'] },
          { key: 't2', members: ['t2', 't1'] },
          { key: 'y', members: ['y'] },
        ],
        lastSelectedEmailKey: 'x',
      });
      useEmailStore.getState().extendSelection(1);
      expect(keys()).toEqual(['t1', 't2', 'x']);
      useEmailStore.getState().extendSelection(-1);
      expect(keys()).toEqual(['x']);
    });
  });

  describe('selectAllEmails', () => {
    it('should select all emails', () => {
      useEmailStore.getState().selectAllEmails();
      expect(useEmailStore.getState().selectedEmailKeys.size).toBe(5);
    });
  });

  describe('clearSelection', () => {
    it('should clear all selections and reset anchor', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'a' });
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      useEmailStore.getState().clearSelection();
      expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
      expect(useEmailStore.getState().lastSelectedEmailKey).toBeNull();
    });
  });
});
