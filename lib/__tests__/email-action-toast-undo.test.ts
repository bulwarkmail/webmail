import { describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

import { undoMoveAction } from '../email-action-toast';
import { useEmailStore, type CrossAccountMoveReceipt, type EmailRestoreBatch } from '@/stores/email-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const labels = { undo: 'Undo', done: 'Undone', failed: "Couldn't undo" };

describe('undoMoveAction', () => {
  it('hands Undo the messages that went to another account, filled in after the move ran', async () => {
    const undoMove = vi.fn().mockResolvedValue(undefined);
    useEmailStore.setState({ undoMove: undoMove as never });
    const client = {} as IJMAPClient;
    const batches: EmailRestoreBatch[] = [{ client, points: [{ id: 'e1', mailboxIds: { inbox: true }, seen: true }] }];
    const receipts: CrossAccountMoveReceipt[] = [];

    const action = undoMoveAction(client, batches, labels, receipts);
    expect(action?.label).toBe('Undo');
    // The move runs after the toast's action was made.
    receipts.push({ sourceLogin: 'a', sourceJmapAccountId: 'A', sourceEmailId: 'e1', destLogin: 'b', destJmapAccountId: 'B', destEmailId: 'c1' });

    action!.onClick();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Undone', { group: 'undo' }));
    expect(undoMove).toHaveBeenCalledWith(client, batches, receipts);
    expect(undoMove.mock.calls[0][2]).toHaveLength(1);
  });
});
