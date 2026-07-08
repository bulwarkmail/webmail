import { describe, it, expect } from 'vitest';
import { sortDefaultFirst, reorderNonDefaultIds, type OrderableAccount } from '../account-utils';

const acct = (id: string, isDefault = false): OrderableAccount => ({ id, isDefault });

describe('sortDefaultFirst', () => {
  it('pins the default account to the front, preserving the rest order', () => {
    const accounts = [acct('a'), acct('b', true), acct('c')];
    expect(sortDefaultFirst(accounts).map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op shape when the default is already first', () => {
    const accounts = [acct('b', true), acct('a'), acct('c')];
    expect(sortDefaultFirst(accounts).map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const accounts = [acct('a'), acct('b', true)];
    const snapshot = accounts.map((a) => a.id);
    sortDefaultFirst(accounts);
    expect(accounts.map((a) => a.id)).toEqual(snapshot);
  });
});

describe('reorderNonDefaultIds', () => {
  // default 'd' stays index 0; non-defaults are a, b, c
  const accounts = [acct('d', true), acct('a'), acct('b'), acct('c')];

  it('moves a non-default onto a later position, keeping default pinned', () => {
    expect(reorderNonDefaultIds(accounts, 'a', 'c')).toEqual(['d', 'b', 'c', 'a']);
  });

  it('moves a non-default earlier', () => {
    expect(reorderNonDefaultIds(accounts, 'c', 'a')).toEqual(['d', 'c', 'a', 'b']);
  });

  it('returns null for a no-op (same id)', () => {
    expect(reorderNonDefaultIds(accounts, 'a', 'a')).toBeNull();
  });

  it('returns null when the default is dragged or targeted', () => {
    expect(reorderNonDefaultIds(accounts, 'd', 'a')).toBeNull();
    expect(reorderNonDefaultIds(accounts, 'a', 'd')).toBeNull();
  });
});
