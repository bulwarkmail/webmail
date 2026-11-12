import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { clearUndoHistory, undoHistory } from '@/lib/undo-history';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useToastStore } from '@/stores/toast-store';
import { movedNotice, restoreBatchesFromNotice, takeOverMoved } from '../moved-undo';

// A message window deleted, archived or moved its message and handed the Undo
// to the main window, naming the login the message is in. Message and folder
// ids repeat across logins, so the main window may undo through that login
// only. When it has no client for it, there is nothing to undo here: through
// the active login the same ids are another message and other folders.

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
const t = (key: string) => key;
const POINTS = [{ id: 'eaaaaab', mailboxIds: { a: true }, seen: false }];

function makeClient(name: string) {
  return {
    name,
    getAccountId: () => name,
    restoreEmails: vi.fn().mockResolvedValue(undefined),
    setEmailMailboxes: vi.fn().mockResolvedValue(undefined),
    batchSetMailboxIds: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi.fn().mockResolvedValue([]),
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
  };
}

describe('an Undo handed over for a login this window has no client for', () => {
  let alice: ReturnType<typeof makeClient>;

  beforeEach(() => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    alice = makeClient('alice');
    // Alice is the active login here. Bob is not connected in this window.
    useAuthStore.setState({
      activeAccountId: 'alice',
      client: alice as never,
      getAllConnectedClients: () => new Map([['alice', alice]]) as never,
      getClientForAccount: (id: string) => (id === 'alice' ? alice : undefined) as never,
    });
    useToastStore.getState().clearToasts();
    clearUndoHistory();
  });

  afterEach(() => {
    useAuthStore.setState(original.auth);
    useEmailStore.setState(original.email);
    vi.unstubAllGlobals();
  });

  it('is not turned into a restore through the active login', () => {
    const batches = restoreBatchesFromNotice({ kind: 'delete', batches: [{ login: 'bob', accountId: undefined, points: POINTS }] });
    expect(batches.map((batch) => (batch.client as unknown as { name: string }).name)).toEqual([]);
  });

  it('offers no Undo that would move the active login\'s message with that id', () => {
    takeOverMoved({ kind: 'delete', batches: [{ login: 'bob', accountId: undefined, points: POINTS }] }, t);
    // Ctrl+Z and the toast's button run the same entry.
    for (const entry of undoHistory()) (entry as unknown as { run?: () => void; undo?: () => void }).run?.();
    expect(undoHistory()).toHaveLength(0);
  });

  it('a notice that names no login is not undone through the active login either', () => {
    // movedNotice writes null when the window's client is not among its connected logins.
    const stranger = makeClient('stranger');
    const notice = movedNotice('move', [{ client: stranger as never, accountId: undefined, points: POINTS }]);
    expect(notice.batches[0].login).toBeNull();
    expect(restoreBatchesFromNotice(notice)).toEqual([]);
  });
});
