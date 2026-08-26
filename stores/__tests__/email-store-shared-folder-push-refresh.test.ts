import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Mailbox, StateChange } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Regression coverage for the open list going stale on a shared/group folder.
//
// Stalwart's SSE only pushes StateChange for the primary account, never for a
// delegated/shared owner, so changes to those arrive via the client's secondary
// poll - reported under the OWNER's accountId. `handleStateChange` keyed the
// email-list refresh off `change.changed[primaryAccountId]` only, so while a
// shared folder was open a background Email change refreshed the folder
// COUNTERS (those already react to any account) but never refetched the rows.
// A server-side keyword patch - an operator job stamping a colour label, or
// another member of the shared mailbox acting on it - stayed invisible until a
// hard reload.

const PRIMARY = 'primary-account';
const OWNER = 'shared-owner-account';

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true, mayAddItems: true, mayRemoveItems: true,
      maySetSeen: true, maySetKeywords: true, mayCreateChild: true,
      mayRename: true, mayDelete: true, maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  };
}

const client = { getAccountId: () => PRIMARY } as unknown as IJMAPClient;

const change = (changed: StateChange['changed']): StateChange =>
  ({ '@type': 'StateChange', changed }) as StateChange;

describe('handleStateChange refreshes the open shared folder', () => {
  let refreshCurrentMailbox: ReturnType<typeof vi.fn>;

  const seed = (over: Record<string, unknown> = {}) => {
    refreshCurrentMailbox = vi.fn().mockResolvedValue(undefined);
    useEmailStore.setState({
      selectedMailbox: 'shared-inbox',
      // `isShared` is load-bearing: resolveViewAccountId() only reports an
      // owner account for a shared folder.
      mailboxes: [makeMailbox({ id: 'shared-inbox', accountId: OWNER, isShared: true })],
      accountMailboxes: {},
      viewingAccountId: undefined,
      isUnifiedView: false,
      refreshCurrentMailbox,
      fetchTagCounts: vi.fn(),
      fetchMailboxes: vi.fn().mockResolvedValue(undefined),
      ...over,
    } as never);
  };

  beforeEach(() => seed());

  it('refetches the rows when the OWNER account of the viewed folder changed', async () => {
    await useEmailStore.getState().handleStateChange(change({ [OWNER]: { Email: 'state-2' } }), client);
    expect(refreshCurrentMailbox).toHaveBeenCalled();
  });

  it('still refetches on a primary-account change (unchanged behaviour)', async () => {
    await useEmailStore.getState().handleStateChange(change({ [PRIMARY]: { Email: 'state-2' } }), client);
    expect(refreshCurrentMailbox).toHaveBeenCalled();
  });

  it('does not refetch for an unrelated account while a shared folder is open', async () => {
    await useEmailStore.getState().handleStateChange(change({ 'other-account': { Email: 'state-2' } }), client);
    expect(refreshCurrentMailbox).not.toHaveBeenCalled();
  });

  it('does not refetch when only the MAILBOX state moved (counters only)', async () => {
    await useEmailStore.getState().handleStateChange(change({ [OWNER]: { Mailbox: 'state-2' } }), client);
    expect(refreshCurrentMailbox).not.toHaveBeenCalled();
  });

  it('leaves an own-account view untouched by a shared account change', async () => {
    seed({
      selectedMailbox: 'inbox',
      mailboxes: [makeMailbox({ id: 'inbox' })],
    });
    await useEmailStore.getState().handleStateChange(change({ [OWNER]: { Email: 'state-2' } }), client);
    expect(refreshCurrentMailbox).not.toHaveBeenCalled();
  });

  // The aggregate views contribute shared accounts too, so they take any
  // contributing account's Email change.
  it('refetches an aggregate view on any contributing account change', async () => {
    seed({ isUnifiedView: true });
    await useEmailStore.getState().handleStateChange(change({ 'other-account': { Email: 'state-2' } }), client);
    expect(refreshCurrentMailbox).toHaveBeenCalled();
  });
});
