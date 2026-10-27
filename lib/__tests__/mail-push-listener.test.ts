import { describe, expect, it, vi } from 'vitest';
import { createMailPushListener } from '../mail-push-listener';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { StateChange } from '@/lib/jmap/types';

// The unified inbox lists the mail of every signed-in login. New mail of a
// login other than the active one only refreshed the counters; the list
// waited for the next click (#1350).

const push = (changed: StateChange['changed']): StateChange => ({ '@type': 'StateChange', changed });
const second = { getAccountId: () => 'b' } as unknown as IJMAPClient;

function setup(isUnifiedView: boolean) {
  const handlers = {
    handleStateChange: vi.fn(),
    invalidateUnifiedMailboxes: vi.fn(),
    buildPopulatedUnifiedAccounts: vi.fn(async () => []),
    refreshCrossCounts: vi.fn(),
    refreshUnifiedCounts: vi.fn(),
    isUnifiedView: () => isUnifiedView,
    refreshList: vi.fn(),
  };
  return { handlers, listen: createMailPushListener(() => handlers) };
}

describe('mail push of a background login', () => {
  it('refreshes the unified list for its new mail', () => {
    const { handlers, listen } = setup(true);
    listen(push({ b: { Email: 'e2', Mailbox: 'm2' } }), second, 'background');
    expect(handlers.refreshList).toHaveBeenCalledTimes(1);
    expect(handlers.buildPopulatedUnifiedAccounts).toHaveBeenCalledTimes(1);
  });

  it('leaves a single folder of the active login alone', () => {
    const { handlers, listen } = setup(false);
    listen(push({ b: { Email: 'e2' } }), second, 'background');
    expect(handlers.refreshList).not.toHaveBeenCalled();
  });

  it('leaves the list alone when only its folder counters changed', () => {
    const { handlers, listen } = setup(true);
    listen(push({ b: { Mailbox: 'm2' } }), second, 'background');
    expect(handlers.refreshList).not.toHaveBeenCalled();
  });

  it('hands the active login to the full handler', () => {
    const { handlers, listen } = setup(true);
    listen(push({ a: { Email: 'e2' } }), second, 'active');
    expect(handlers.handleStateChange).toHaveBeenCalledTimes(1);
    expect(handlers.refreshList).not.toHaveBeenCalled();
  });
});
