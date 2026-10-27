import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { UNIFIED_MAILBOX_IDS, type StateChange } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The unified inbox fans out over the own account and the group and shared
// accounts included in it (#328). New mail in a group account only refreshed
// the counters; the list waited for the next click (#1350).

const client = {
  getAccountId: () => 'own',
  getTagCounts: vi.fn(async () => ({})),
} as unknown as IJMAPClient;

const push = (changed: StateChange['changed']): StateChange => ({ '@type': 'StateChange', changed });

describe('push in the unified view', () => {
  const original = useEmailStore.getState().refreshCurrentMailbox;
  const refresh = vi.fn(async () => {});

  beforeEach(() => {
    refresh.mockClear();
    useEmailStore.setState({
      refreshCurrentMailbox: refresh,
      isUnifiedView: true,
      unifiedRole: 'inbox',
      selectedMailbox: UNIFIED_MAILBOX_IDS.inbox,
      selectedKeyword: null,
      searchQuery: '',
      emailListSync: null,
    });
  });
  afterEach(() => useEmailStore.setState({ refreshCurrentMailbox: original, isUnifiedView: false, unifiedRole: null }));

  it('refreshes the list for an Email change in a group account', async () => {
    await useEmailStore.getState().handleStateChange(push({ grp: { Email: 'g2' } }), client);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves the list alone when only folder counters changed', async () => {
    useEmailStore.setState({ applyMailboxDelta: vi.fn(async () => true) } as never);
    await useEmailStore.getState().handleStateChange(push({ grp: { Mailbox: 'm2' } }), client);
    expect(refresh).not.toHaveBeenCalled();
  });
});
