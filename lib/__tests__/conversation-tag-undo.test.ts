import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setConversationTagsWithUndo, type UndoLabels } from '../email-action-toast';
import { clearUndoHistory, undoHistory, undoLatest } from '../undo-history';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #460: tagging a conversation row writes the tag on every message of the
// conversation, one Email/set per account, and Ctrl+Z takes it off the
// messages that got it.

const labels: UndoLabels = { undo: 'Undo', done: 'Moved back', failed: "Couldn't undo", undone: 'Undone' };
const client = { getAccountId: () => 'me' } as unknown as IJMAPClient;
const words = { describe: () => 'Tagged', labels };

const email = (id: string, keywords: Record<string, boolean> = {}) =>
  ({ id, threadId: 't1', keywords, mailboxIds: { inbox: true } }) as unknown as Email;

let patchEmailKeywords: ReturnType<typeof vi.fn>;
let batchUpdateKeywords: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearUndoHistory();
  patchEmailKeywords = vi.fn().mockResolvedValue(true);
  batchUpdateKeywords = vi.fn().mockResolvedValue(undefined);
  (client as unknown as { batchUpdateKeywords: unknown }).batchUpdateKeywords = batchUpdateKeywords;
  useAuthStore.setState({ client, activeAccountId: 'me', getClientForAccount: () => undefined } as never);
  useEmailStore.setState({
    emails: [email('a', { '$label:work': true }), email('b'), email('c')],
    mailboxes: [], selectedMailbox: 'inbox', selectedEmailKeys: new Set(),
    patchEmailKeywords: patchEmailKeywords as never,
    fetchTagCounts: vi.fn() as never,
  });
});

describe('setConversationTagsWithUndo', () => {
  it('puts the tag on every message of the conversation in one write', async () => {
    const conversation = useEmailStore.getState().emails;
    await setConversationTagsWithUndo(client, conversation, ['home'], true, words);

    expect(batchUpdateKeywords).toHaveBeenCalledTimes(1);
    const [ids, patch] = batchUpdateKeywords.mock.calls[0];
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
    expect(patch).toEqual({ 'keywords/$label:home': true });
    expect(useEmailStore.getState().emails.every((e) => e.keywords['$label:home'])).toBe(true);
  });

  it('takes the tag off every message that has it, and Undo puts it back on those only', async () => {
    useEmailStore.setState({ emails: [email('a', { '$label:work': true }), email('b', { '$color:work': true }), email('c')] });
    const conversation = useEmailStore.getState().emails;
    await setConversationTagsWithUndo(client, conversation, ['work'], false, words);

    expect(batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect([...batchUpdateKeywords.mock.calls[0][0]].sort()).toEqual(['a', 'b']);
    expect(useEmailStore.getState().emails.some((e) => e.keywords['$label:work'] || e.keywords['$color:work'])).toBe(false);

    expect(undoHistory()).toHaveLength(1);
    undoLatest();
    await vi.waitFor(() => expect(patchEmailKeywords).toHaveBeenCalledTimes(2));
    expect(patchEmailKeywords).toHaveBeenCalledWith(client, 'a', { '$label:work': true, '$color:work': false }, 'a');
    expect(patchEmailKeywords).toHaveBeenCalledWith(client, 'b', { '$label:work': false, '$color:work': true }, 'b');
  });

  it('writes each message to its own account in a merged view', async () => {
    const team = { getAccountId: () => 'me', batchUpdateKeywords: vi.fn().mockResolvedValue(undefined) } as unknown as IJMAPClient;
    const own = { ...email('a'), sourceClientAccountId: 'test', sourceAccountId: 'me' } as Email;
    const shared = { ...email('b'), sourceClientAccountId: 'login-2', sourceAccountId: 'team' } as Email;
    useAuthStore.setState({ getClientForAccount: ((id: string) => (id === 'login-2' ? team : id === 'test' ? client : undefined)) as never });
    useEmailStore.setState({ emails: [own, shared] });

    await setConversationTagsWithUndo(client, [own, shared], ['home'], true, words);

    expect(batchUpdateKeywords).toHaveBeenCalledWith(['a'], { 'keywords/$label:home': true }, 'me');
    expect((team as unknown as { batchUpdateKeywords: ReturnType<typeof vi.fn> }).batchUpdateKeywords)
      .toHaveBeenCalledWith(['b'], { 'keywords/$label:home': true }, 'team');
  });
});
