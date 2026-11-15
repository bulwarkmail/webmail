import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keywordRestorePoints, markSelectionReadWithUndo, recordQuietUndo, setSelectionTagWithUndo, undoKeywordAction,
  type UndoLabels,
} from '../email-action-toast';
import { clearUndoHistory, undoHistory, undoLatest } from '../undo-history';
import { useEmailStore } from '@/stores/email-store';
import { useToastStore } from '@/stores/toast-store';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const labels: UndoLabels = { undo: 'Undo', done: 'Moved back', failed: "Couldn't undo", undone: 'Undone' };
const client = {} as IJMAPClient;

const email = (id: string, keywords: Record<string, boolean> = {}) => ({ id, keywords, mailboxIds: { inbox: true } }) as unknown as Email;

let patchEmailKeywords: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearUndoHistory();
  useToastStore.setState({ toasts: [] });
  patchEmailKeywords = vi.fn().mockResolvedValue(true);
  useEmailStore.setState({
    emails: [email('read', { $seen: true }), email('unread'), email('tagged', { '$label:red': true })],
    threadEmailsCache: new Map(),
    selectedEmailKeys: new Set(['read', 'unread']),
    error: null,
    patchEmailKeywords: patchEmailKeywords as never,
  });
});

describe('keyword restore points', () => {
  it('keeps the values the keywords have now, leaving out messages already in the wanted state', () => {
    const points = keywordRestorePoints(useEmailStore.getState().emails, ['$seen'], { $seen: true });
    expect(points).toEqual([
      { id: 'unread', key: 'unread', changes: { $seen: false } },
      { id: 'tagged', key: 'tagged', changes: { $seen: false } },
    ]);
  });
});

describe('undo for read, flag and tag changes', () => {
  it('marks the selection read with a toast whose Undo puts back only what changed', async () => {
    const batchMarkAsRead = vi.fn().mockResolvedValue(true);
    useEmailStore.setState({ batchMarkAsRead: batchMarkAsRead as never });

    await markSelectionReadWithUndo(client, true, { success: '2 emails marked as read', error: 'Failed', labels });

    expect(batchMarkAsRead).toHaveBeenCalledWith(client, true);
    const shown = useToastStore.getState().toasts.at(-1)!;
    expect(shown.title).toBe('2 emails marked as read');
    expect(shown.action?.label).toBe('Undo');

    // Ctrl+Z (the history) or the toast: the same Undo.
    undoLatest();
    await vi.waitFor(() => expect(patchEmailKeywords).toHaveBeenCalledTimes(1));
    expect(patchEmailKeywords).toHaveBeenCalledWith(client, 'unread', { $seen: false }, 'unread');
    await vi.waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Undone'));
  });

  it('keeps an Undo for a tag put on the selection, without a toast', async () => {
    const batchSetTag = vi.fn().mockResolvedValue(true);
    useEmailStore.setState({ batchSetTag: batchSetTag as never, selectedEmailKeys: new Set(['unread', 'tagged']) });

    await setSelectionTagWithUndo(client, 'red', true, { describe: (n) => `${n} emails tagged`, labels });

    expect(batchSetTag).toHaveBeenCalledWith(client, 'red', true);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(undoHistory().map((e) => e.label)).toEqual(['1 emails tagged']);

    undoLatest();
    await vi.waitFor(() => expect(patchEmailKeywords).toHaveBeenCalledTimes(1));
    // Only the message that got the tag loses it again.
    expect(patchEmailKeywords).toHaveBeenCalledWith(client, 'unread', { '$label:red': false, '$color:red': false }, 'unread');
  });

  it('keeps no Undo when a plugin stopped the tag change', async () => {
    useEmailStore.setState({ batchSetTag: vi.fn().mockResolvedValue(false) as never });
    await setSelectionTagWithUndo(client, 'red', true, { describe: () => 'tagged', labels });
    expect(undoHistory()).toHaveLength(0);
  });

  it('says when the undo failed', async () => {
    patchEmailKeywords.mockRejectedValue(new Error('read-only'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recordQuietUndo('Email starred', undoKeywordAction(client, [{ id: 'x', key: 'x', changes: { $flagged: false } }], labels));
    undoLatest();
    await vi.waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Couldn't undo"));
  });
});
