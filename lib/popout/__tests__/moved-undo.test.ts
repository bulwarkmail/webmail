import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { clearUndoHistory, undoHistory } from '@/lib/undo-history';
import { useAuthStore } from '@/stores/auth-store';
import { useToastStore } from '@/stores/toast-store';
import { movedNotice, offerMoveUndo, restoreBatchesFromNotice } from '../moved-undo';

const original = useAuthStore.getState();
const alice = { name: 'alice' };
const bob = { name: 'bob' };
const t = (key: string) => key;
const POINTS = [{ id: 'm1', mailboxIds: { inbox: true }, seen: false }];

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  useAuthStore.setState({
    client: alice as never,
    getAllConnectedClients: () => new Map([['alice', alice], ['bob', bob]]) as never,
    getClientForAccount: (id: string) => ({ alice, bob } as Record<string, unknown>)[id] as never,
  });
  useToastStore.getState().clearToasts();
  clearUndoHistory();
});

afterEach(() => {
  useAuthStore.setState(original);
  vi.unstubAllGlobals();
});

describe('moved-undo', () => {
  it('names each batch by its login, and another window finds its own connection for it', () => {
    const notice = movedNotice('move', [{ client: bob as never, accountId: 'shared', points: POINTS }]);
    expect(notice).toEqual({ kind: 'move', batches: [{ login: 'bob', accountId: 'shared', points: POINTS }] });
    expect(restoreBatchesFromNotice(notice)).toEqual([{ client: bob, accountId: 'shared', points: POINTS }]);
  });

  it('with no main window to take it, the message window keeps the Undo itself', async () => {
    await offerMoveUndo('archive', alice as never, [{ client: alice as never, points: POINTS }], t, true);
    // The main window's words (mail-18), not "Email archived".
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['mail_list_extra.archived']);
    expect(undoHistory()).toHaveLength(1);
  });

  it('says "Moved to Trash" for a delete with Undo, and "Email deleted" only for one for good', async () => {
    await offerMoveUndo('delete', alice as never, [{ client: alice as never, points: POINTS }], t, true);
    await offerMoveUndo('delete', alice as never, null, t, true);
    expect(useToastStore.getState().toasts.map((toast) => toast.title))
      .toEqual(expect.arrayContaining(['mail_list_extra.moved_to_trash', 'notifications.email_deleted']));
  });
});
