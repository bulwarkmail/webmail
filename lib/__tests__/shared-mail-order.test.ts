import { describe, it, expect } from 'vitest';
import { moveSharedMailAccount, sharedMailOrderIds, sortSharedMailAccounts } from '../shared-mail-order';

const nodes = (...ids: string[]) => ids.map((accountId) => ({ accountId }));
const ids = (list: { accountId?: string }[]) => list.map((n) => n.accountId);

describe('sortSharedMailAccounts', () => {
  it('keeps the incoming (alphabetical) order without a stored order', () => {
    expect(ids(sortSharedMailAccounts(nodes('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c']);
    expect(ids(sortSharedMailAccounts(nodes('a', 'b', 'c'), undefined))).toEqual(['a', 'b', 'c']);
  });

  it('puts stored accounts first and appends the others in their incoming order', () => {
    expect(ids(sortSharedMailAccounts(nodes('a', 'b', 'c', 'd'), ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores stored ids of accounts that are not present', () => {
    expect(ids(sortSharedMailAccounts(nodes('a', 'b'), ['gone', 'b']))).toEqual(['b', 'a']);
  });
});

describe('sharedMailOrderIds', () => {
  it('reads one login\'s entry', () => {
    expect(sharedMailOrderIds({ x: ['a'] }, 'x')).toEqual(['a']);
    expect(sharedMailOrderIds({ x: ['a'] }, 'y')).toEqual([]);
    expect(sharedMailOrderIds(undefined, 'x')).toEqual([]);
    expect(sharedMailOrderIds({ x: 'a' as never }, 'x')).toEqual([]);
  });
});

describe('moveSharedMailAccount', () => {
  it('moves an account down onto the target\'s position', () => {
    expect(moveSharedMailAccount({}, 'x', ['a', 'b', 'c'], 'a', 'c')).toEqual({ x: ['b', 'c', 'a'] });
  });

  it('moves an account up onto the target\'s position', () => {
    expect(moveSharedMailAccount({}, 'x', ['a', 'b', 'c'], 'c', 'b')).toEqual({ x: ['a', 'c', 'b'] });
  });

  it('keeps hidden accounts in their slot', () => {
    // b is hidden; moving c above a must not change where b sits relative to a.
    const map = moveSharedMailAccount({}, 'x', ['a', 'b', 'c'], 'c', 'a');
    expect(map.x).toEqual(['c', 'a', 'b']);
    expect(ids(sortSharedMailAccounts(nodes('a', 'b', 'c'), map.x))).toEqual(['c', 'a', 'b']);
  });

  it('keeps stored ids whose account is not present', () => {
    const map = moveSharedMailAccount({ x: ['gone', 'a', 'b'] }, 'x', ['a', 'b'], 'b', 'a');
    expect(map.x).toEqual(['b', 'a', 'gone']);
  });

  it('leaves other logins untouched', () => {
    const before = { y: ['q', 'p'] };
    const map = moveSharedMailAccount(before, 'x', ['a', 'b'], 'b', 'a');
    expect(map).toEqual({ y: ['q', 'p'], x: ['b', 'a'] });
    expect(before).toEqual({ y: ['q', 'p'] });
  });

  it('changes nothing for a drop on itself or an unknown id', () => {
    const map = { x: ['a', 'b'] };
    expect(moveSharedMailAccount(map, 'x', ['a', 'b'], 'a', 'a')).toBe(map);
    expect(moveSharedMailAccount(map, 'x', ['a', 'b'], 'a', 'zz')).toBe(map);
  });
});
