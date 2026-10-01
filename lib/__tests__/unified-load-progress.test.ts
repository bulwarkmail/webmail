import { describe, expect, it } from 'vitest';
import { unifiedLoadProgress } from '@/lib/unified-mailbox';

// While a browser restores its logins the unified counts cover only the ones
// already back. The sidebar says how many, so a partial total is not read as
// the whole - and stops saying it the moment the restore is over.
const scope = (...ids: string[]) => ids.map((id) => ({ clientAccountId: id, isShared: false }));
const accounts = (n: number, failed = 0) =>
  Array.from({ length: n }, (_, i) => ({ hasError: i < failed }));

describe('unifiedLoadProgress', () => {
  it('counts the logins already in the scope against those expected', () => {
    expect(unifiedLoadProgress({ crossAccountActive: true, restoring: true, scope: scope('a', 'b', 'c', 'd'), accounts: accounts(10) }))
      .toEqual({ loaded: 4, total: 10 });
  });

  it('leaves out logins whose restore failed', () => {
    expect(unifiedLoadProgress({ crossAccountActive: true, restoring: true, scope: scope('a', 'b'), accounts: accounts(4, 1) }))
      .toEqual({ loaded: 2, total: 3 });
  });

  it('counts a login once however many shared owners it brings', () => {
    const withShared = [...scope('a'), { clientAccountId: 'a', isShared: true }, { clientAccountId: 'a', isShared: true }];
    expect(unifiedLoadProgress({ crossAccountActive: true, restoring: true, scope: withShared, accounts: accounts(3) }))
      .toEqual({ loaded: 1, total: 3 });
  });

  it('says nothing once the scope is complete, the restore is over, or there is one login', () => {
    expect(unifiedLoadProgress({ crossAccountActive: true, restoring: true, scope: scope('a', 'b'), accounts: accounts(2) })).toBeNull();
    expect(unifiedLoadProgress({ crossAccountActive: true, restoring: false, scope: scope('a'), accounts: accounts(5) })).toBeNull();
    expect(unifiedLoadProgress({ crossAccountActive: true, restoring: true, scope: [], accounts: accounts(1) })).toBeNull();
  });

  it('says nothing when the unified mailbox stays within one login', () => {
    expect(unifiedLoadProgress({ crossAccountActive: false, restoring: true, scope: scope('a'), accounts: accounts(5) })).toBeNull();
  });
});
