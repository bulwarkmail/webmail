import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  snapshotAccount,
  restoreAccount,
  clearAllStores,
  evictAccount,
  evictAll,
} from '@/lib/account-state-manager';
import { useEmailStore } from '@/stores/email-store';
import { useContactStore } from '@/stores/contact-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useFilterStore } from '@/stores/filter-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useVacationStore } from '@/stores/vacation-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { makeEmail, makeMailbox } from './helpers/factories';

// The store singletons and the module-level snapshot cache persist across
// tests; reset both around every test.
beforeEach(() => evictAll());
afterEach(() => evictAll());

describe('snapshotAccount / restoreAccount', () => {
  it('round-trips the captured fields across all six stores', () => {
    useEmailStore.setState({
      emails: [makeEmail({ id: 'a1' })],
      mailboxes: [makeMailbox({ id: 'a-in' })],
      selectedMailbox: 'a-in',
      searchQuery: 'queryA',
      quota: { used: 1, total: 2 },
    });
    useContactStore.setState({ supportsSync: true });
    useCalendarStore.setState({ viewMode: 'week', supportsCalendar: true });
    useFilterStore.setState({ isSupported: true });
    useIdentityStore.setState({ preferredPrimaryId: 'idA' });
    useVacationStore.setState({ isEnabled: true });

    snapshotAccount('A');

    // Mutate everything to "account B" values.
    useEmailStore.setState({ emails: [], selectedMailbox: 'b-in', searchQuery: 'queryB', quota: null });
    useContactStore.setState({ supportsSync: false });
    useCalendarStore.setState({ viewMode: 'month', supportsCalendar: false });
    useFilterStore.setState({ isSupported: false });
    useIdentityStore.setState({ preferredPrimaryId: 'idB' });
    useVacationStore.setState({ isEnabled: false });

    expect(restoreAccount('A')).toBe(true);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a1']);
    expect(useEmailStore.getState().selectedMailbox).toBe('a-in');
    expect(useEmailStore.getState().searchQuery).toBe('queryA');
    expect(useEmailStore.getState().quota).toEqual({ used: 1, total: 2 });
    expect(useContactStore.getState().supportsSync).toBe(true);
    expect(useCalendarStore.getState().viewMode).toBe('week');
    expect(useFilterStore.getState().isSupported).toBe(true);
    expect(useIdentityStore.getState().preferredPrimaryId).toBe('idA');
    expect(useVacationStore.getState().isEnabled).toBe(true);
  });

  it('resets fields outside the snapshot subset to their defaults (no cross-account leak)', () => {
    // isLoading is NOT part of the email snapshot subset.
    useEmailStore.setState({ selectedMailbox: 'a-in', isLoading: false });
    snapshotAccount('A');
    useEmailStore.setState({ selectedMailbox: 'b-in', isLoading: true });

    restoreAccount('A');

    expect(useEmailStore.getState().selectedMailbox).toBe('a-in'); // captured → restored
    expect(useEmailStore.getState().isLoading).toBe(false); // uncaptured → reset, not leaked
  });

  it('decouples the snapshot from later in-place mutation of the source array', () => {
    const arr = [makeEmail({ id: '1' })];
    useEmailStore.setState({ emails: arr });
    snapshotAccount('A');
    arr.push(makeEmail({ id: '2' })); // mutate the same array after snapshot
    useEmailStore.setState({ emails: [] });

    restoreAccount('A');
    // The post-snapshot mutation did NOT leak into the snapshot.
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['1']);
  });

  it('returns false and leaves stores untouched for an unknown account', () => {
    useEmailStore.setState({ searchQuery: 'keep' });
    expect(restoreAccount('nope')).toBe(false);
    expect(useEmailStore.getState().searchQuery).toBe('keep');
  });
});

describe('clearAllStores', () => {
  it('resets the email store to fresh empty collections', () => {
    useEmailStore.setState({
      emails: [makeEmail({ id: 'x' })],
      selectedEmailIds: new Set(['x']),
      searchQuery: 'q',
      tagCounts: { a: { total: 1, unread: 0 } },
      threadEmailsCache: new Map([['t', []]]),
    });

    clearAllStores();

    const s = useEmailStore.getState();
    expect(s.emails).toEqual([]);
    expect(s.searchQuery).toBe('');
    expect(s.selectedEmailIds.size).toBe(0);
    expect(s.threadEmailsCache.size).toBe(0);
    expect(s.tagCounts).toEqual({});
    expect(s.searchFilters).toEqual(DEFAULT_SEARCH_FILTERS);
  });
});

describe('evictAccount / evictAll', () => {
  it('evictAccount drops a single snapshot', () => {
    snapshotAccount('A');
    evictAccount('A');
    expect(restoreAccount('A')).toBe(false);
  });

  it('evictAll drops every snapshot', () => {
    snapshotAccount('B');
    snapshotAccount('C');
    evictAll();
    expect(restoreAccount('B')).toBe(false);
    expect(restoreAccount('C')).toBe(false);
  });
});
