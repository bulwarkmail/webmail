import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { DragDropProvider, useDragDropContext } from '@/contexts/drag-drop-context';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useTagDrop } from '../use-tag-drop';

// Messages dropped on a tag in the sidebar. The drag's payload names the
// messages by id only, and ids repeat across accounts and logins: the tag
// has to go to the rows that were dragged, each through the login and into
// the account it was listed from.

const ID = 'eaaaaab';
const LABEL = { 'keywords/$label:work': true };
const row = (stamps: Partial<Email> = {}): Email => ({
  id: ID, threadId: 't', subject: 'Hello', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, ...stamps,
}) as Email;
const folder = (accountId: string): Mailbox => ({ id: 'a', originalId: 'a', name: 'Inbox', role: 'inbox', accountId, isShared: false }) as Mailbox;
const makeClient = (account: string) => ({
  getAccountId: () => account,
  batchUpdateKeywords: vi.fn(async () => {}),
});

function Tag({ rows }: { rows: Email[] }) {
  const { startDrag } = useDragDropContext();
  const { dropHandlers } = useTagDrop({ tagId: 'work' });
  return (
    <div data-testid="tag" {...dropHandlers}>
      <button onClick={() => startDrag(rows, 'a')}>drag</button>
    </div>
  );
}

async function dragOntoTag(rows: Email[]) {
  render(<DragDropProvider><Tag rows={rows} /></DragDropProvider>);
  fireEvent.click(screen.getByText('drag'));
  const ids = JSON.stringify(rows.map((dragged) => dragged.id));
  await act(async () => {
    fireEvent.drop(screen.getByTestId('tag'), { dataTransfer: { getData: (type: string) => (type === 'application/x-email-ids' ? ids : '') } });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
let a: ReturnType<typeof makeClient>;
let b: ReturnType<typeof makeClient>;
let connected: Map<string, ReturnType<typeof makeClient>>;

beforeEach(() => {
  a = makeClient('ee');
  b = makeClient('ef');
  connected = new Map([['login-a', a], ['login-b', b]]);
  useAuthStore.setState({
    activeAccountId: 'login-a', client: a as never,
    getClientForAccount: ((id: string) => connected.get(id)) as never,
  } as never);
  useEmailStore.setState({
    isUnifiedView: false, viewingAccountId: null, selectedMailbox: 'a', selectedKeyword: null, searchQuery: '',
    mailboxes: [folder('ee')], accountMailboxes: { 'login-b': [folder('ef')] }, emails: [], selectedEmail: null,
    fetchEmails: vi.fn(async () => {}), fetchTagCounts: vi.fn(async () => {}),
  } as never);
});
afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
});

describe('a tag dropped on dragged messages', () => {
  it('in a list that mixes logins goes to the dragged row, not to the first row with its id', async () => {
    const ofA = row({ sourceClientAccountId: 'login-a', sourceAccountId: 'ee' });
    const ofB = row({ sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    useEmailStore.setState({ isUnifiedView: true, selectedMailbox: '__unified_inbox__', emails: [ofA, ofB] } as never);

    await dragOntoTag([ofB]);

    expect(b.batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect(b.batchUpdateKeywords).toHaveBeenCalledWith([ID], LABEL, undefined);
    expect(a.batchUpdateKeywords).not.toHaveBeenCalled();
    const rows = useEmailStore.getState().emails;
    expect(rows.find((listed) => listed.sourceClientAccountId === 'login-b')?.keywords?.['$label:work']).toBe(true);
    expect(rows.find((listed) => listed.sourceClientAccountId === 'login-a')?.keywords?.['$label:work']).toBeUndefined();
  });

  it('for a conversation of a login browsed in the sidebar goes through that login, also for messages the list does not hold', async () => {
    // The conversation's row is listed; its other message is not.
    const listed = row();
    const older = row({ id: 'eaaaaac' });
    useEmailStore.setState({ viewingAccountId: 'login-b', emails: [listed] } as never);

    await dragOntoTag([listed, older]);

    expect(b.batchUpdateKeywords).toHaveBeenCalledTimes(2);
    expect(b.batchUpdateKeywords.mock.calls.map((call: unknown[]) => (call[0] as string[])[0])).toEqual([ID, 'eaaaaac']);
    expect(a.batchUpdateKeywords).not.toHaveBeenCalled();
  });

  it('of a login without a client is not written through the active login', async () => {
    connected.delete('login-b');
    const ofB = row({ sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    useEmailStore.setState({ isUnifiedView: true, selectedMailbox: '__unified_inbox__', emails: [row({ sourceClientAccountId: 'login-a', sourceAccountId: 'ee' }), ofB] } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await dragOntoTag([ofB]);

    expect(a.batchUpdateKeywords).not.toHaveBeenCalled();
    expect(b.batchUpdateKeywords).not.toHaveBeenCalled();
  });

  it('in the active login\'s own folder is written to its own account, as before', async () => {
    const own = row();
    useEmailStore.setState({ emails: [own] } as never);

    await dragOntoTag([own]);

    expect(a.batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect(a.batchUpdateKeywords).toHaveBeenCalledWith([ID], LABEL, undefined);
    expect(useEmailStore.getState().emails[0].keywords?.['$label:work']).toBe(true);
  });
});
