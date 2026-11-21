import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Email } from '@/lib/jmap/types';
import type { NoteEntry } from '@/lib/team-mailboxes/note-format';
import type { TeamRef } from '@/lib/team-mailboxes/team';

// Team notes in a conversation: cards between the messages in time order,
// the field at the end, and every state in one sentence.

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
const client = { getAccountId: () => 'me', getUsername: () => 'tm-alice@example.org' };
let teamContext: { ref: TeamRef; client: unknown } | null = { ref, client };

vi.mock('../use-team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-team')>()),
  useTeamOf: () => teamContext,
}));

const writeNote = vi.fn(async () => 'n-new');
const deleteNote = vi.fn(async () => async () => true);
const reloadTeam = vi.fn(async () => {});
vi.mock('@/stores/team-mailbox-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/team-mailbox-store')>();
  return {
    ...actual,
    loadConversation: vi.fn(async () => {}),
    repairOriginalKeywords: vi.fn(async () => {}),
    writeNote: (...args: unknown[]) => writeNote(...(args as [])),
    deleteNote: (...args: unknown[]) => deleteNote(...(args as [])),
    reloadTeam: (...args: unknown[]) => reloadTeam(...(args as [])),
  };
});

vi.mock('@/lib/directory-scope', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/directory-scope')>();
  return { ...real, loadScopedPrincipalDirectory: vi.fn(async () => ({ principals: [], status: 'ok' })) };
});
const directoryScope = await import('@/lib/directory-scope');

const toastSuccess = vi.fn();
vi.mock('@/stores/toast-store', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), info: vi.fn() } }));

const { useTeamMailboxStore } = await import('@/stores/team-mailbox-store');
const { TeamNotesProvider, NotesAfter, TeamNoteArea, NotesSummaryLine } = await import('../team-conversation');

const message = (id: string, receivedAt: string, extra: Partial<Email> = {}) => ({
  id, threadId: 't1', messageId: [`${id}@client.example`] as unknown as string, subject: 'Offer', receivedAt, keywords: {}, ...extra,
});
const m1 = message('m1', '2026-11-20T09:00:00Z');
const m2 = message('m2', '2026-11-20T12:00:00Z');

const note = (id: string, at: string, text: string, author = { name: 'Bob Baker', email: 'tm-bob@example.org' }, extra: Partial<NoteEntry> = {}): NoteEntry => ({
  id, messageId: `${id}@notes`, key: 'm1@client.example', threadId: 't1', kind: 'note', author, at: Date.parse(at), mentions: [], text, ...extra,
});

function seed(notes: NoteEntry[], patch: Record<string, unknown> = {}) {
  useTeamMailboxStore.setState({
    teams: {
      [ref.key]: {
        ref, status: 'ready', folderIds: ['notes'], canWrite: true,
        author: { name: 'Alice Archer', email: 'tm-alice@example.org' },
        windowStart: 0, notes: Object.fromEntries(notes.map((n) => [n.id, n])), pending: {}, conversations: {}, version: 1,
        ...patch,
      },
    },
  });
}

function Conversation({ messages = [m1, m2] }: { messages?: typeof m1[] }) {
  return (
    <TeamNotesProvider email={messages[0] as unknown as Email} messages={messages as unknown as Email[]}>
      <NotesSummaryLine />
      {messages.map((m) => (
        <div key={m.id}>
          <article data-testid={`message-${m.id}`}>{m.id}</article>
          <NotesAfter emailId={m.id} />
        </div>
      ))}
      <TeamNoteArea messages={messages as unknown as Email[]} />
    </TeamNotesProvider>
  );
}

beforeEach(() => {
  teamContext = { ref, client };
  writeNote.mockClear();
  deleteNote.mockClear();
  reloadTeam.mockClear();
  toastSuccess.mockClear();
});
afterEach(() => useTeamMailboxStore.setState({ teams: {} }));

describe('notes in the conversation', () => {
  it('puts each note after the message it follows, with "Only your team sees this" once', () => {
    seed([note('a', '2026-11-20T10:00:00Z', 'my job'), note('b', '2026-11-20T13:00:00Z', 'waiting for Mabel')]);
    render(<Conversation />);
    const afterFirst = document.querySelector('[data-team-notes-after="m1"]')!;
    const afterSecond = document.querySelector('[data-team-notes-after="m2"]')!;
    expect(within(afterFirst as HTMLElement).getByText('my job')).toBeTruthy();
    expect(within(afterSecond as HTMLElement).getByText('waiting for Mabel')).toBeTruthy();
    expect(document.querySelectorAll('[data-team-only]')).toHaveLength(1);
    expect(afterFirst.querySelector('[data-team-only]')).toBeTruthy();
    // A list, each note named by author and time for screen readers.
    const list = within(afterFirst as HTMLElement).getByRole('list', { name: 'list_label' });
    expect(within(list).getAllByRole('listitem')[0].getAttribute('aria-label')).toBe('note_from');
  });

  it('shows the count and the newest note above the message', () => {
    seed([note('a', '2026-11-20T10:00:00Z', 'my job'), note('t', '2026-11-20T10:30:00Z', '', undefined, { kind: 'done' })]);
    render(<Conversation />);
    const summary = document.querySelector('[data-team-notes-summary]')!;
    // Timeline entries don't count as notes.
    expect(summary.textContent).toContain('summary_count');
    expect(summary.textContent).toContain('summary_latest');
  });

  it('offers Delete only on the user\'s own notes and toasts Undo', async () => {
    seed([note('mine', '2026-11-20T10:00:00Z', 'mine', { name: 'Alice Archer', email: 'tm-alice@example.org' }), note('bobs', '2026-11-20T10:05:00Z', 'bobs')]);
    render(<Conversation />);
    const buttons = screen.getAllByRole('button', { name: 'delete' });
    expect(buttons).toHaveLength(1);
    await act(async () => { fireEvent.click(buttons[0]); });
    expect(deleteNote).toHaveBeenCalledWith(ref.key, 'mine');
    expect(toastSuccess).toHaveBeenCalledWith('deleted', expect.objectContaining({ action: expect.objectContaining({ label: 'undo' }) }));
  });

  it('shows nothing at all outside a team mailbox', () => {
    teamContext = null;
    seed([note('a', '2026-11-20T10:00:00Z', 'my job')]);
    render(<Conversation />);
    expect(document.querySelector('[data-team-notes-after]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'note' })).toBeNull();
  });
});

describe('the note field', () => {
  it('opens in place with one click; Enter sends, Shift+Enter is a new line, Escape keeps the text', async () => {
    seed([]);
    render(<Conversation />);
    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    const field = screen.getByLabelText('field_label') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(field.placeholder).toBe('placeholder');

    fireEvent.change(field, { target: { value: 'my job' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(writeNote).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByLabelText('field_label')).toBeNull();
    // Focus goes back to the Note button, not the page.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'note' }));

    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    const again = screen.getByLabelText('field_label') as HTMLTextAreaElement;
    expect(again.value).toBe('my job');
    await act(async () => { fireEvent.keyDown(again, { key: 'Enter' }); });
    // About the newest message of the conversation.
    expect(writeNote).toHaveBeenCalledWith(ref.key, expect.objectContaining({ emailId: 'm2', key: 'm2@client.example', threadId: 't1' }), { text: 'my job', mentions: [] });
    expect(again.value).toBe('');
  });

  it('offers the team after @, picks by keyboard, and stores the picked person as a mention', async () => {
    const { useTeamNamesStore } = await import('@/lib/team-mailboxes/names');
    useTeamNamesStore.setState({ lists: { [ref.key]: { hv: { name: 'Bob Baker', email: 'tm-bob@example.org' }, hw: { name: 'Carol Cooper', email: 'tm-carol@example.org' } } }, directory: {} });
    seed([]);
    render(<Conversation />);
    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    const field = screen.getByLabelText('field_label') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'ask @ca' } });
    field.setSelectionRange(7, 7);
    fireEvent.keyUp(field, { key: 'a' });
    const list = screen.getByRole('listbox', { name: 'mention_list' });
    expect(list.textContent).toContain('Carol Cooper');
    expect(field.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe('ask @Carol Cooper ');
    expect(writeNote).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'ask @Carol Cooper please' } });
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    expect(writeNote).toHaveBeenCalledWith(ref.key, expect.anything(), { text: 'ask @Carol Cooper please', mentions: ['hw'] });
    useTeamNamesStore.setState({ lists: {}, directory: {} });
  });

  it('offers the directory after the team\'s people once an @ is typed, and can mention someone from it', async () => {
    const { useTeamNamesStore } = await import('@/lib/team-mailboxes/names');
    useTeamNamesStore.setState({ lists: { [ref.key]: { hw: { name: 'Carol Cooper', email: 'tm-carol@example.org' } } }, directory: {} });
    vi.mocked(directoryScope.loadScopedPrincipalDirectory).mockResolvedValue({
      principals: [
        { id: 'ab', type: 'individual', name: 'aaron', description: 'Aaron Abbot', email: 'aaron@example.org' },
        { id: 'grp', type: 'group', name: 'team', email: 'tm-team@example.org' },
      ],
      status: 'ok',
    });
    teamContext = { ref, client: { ...client, supportsPrincipals: () => true } };
    seed([]);
    render(<Conversation />);
    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    const field = screen.getByLabelText('field_label') as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(field, { target: { value: '@' } }); });
    field.setSelectionRange(1, 1);
    await act(async () => { fireEvent.keyUp(field, { key: '@' }); });
    const options = within(screen.getByRole('listbox', { name: 'mention_list' })).getAllByRole('option').map((o) => o.textContent);
    // The team's people first, then the directory; never the group itself.
    expect(options).toEqual([expect.stringContaining('Carol Cooper'), expect.stringContaining('Aaron Abbot')]);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe('@Aaron Abbot ');
    fireEvent.change(field, { target: { value: '@Aaron Abbot can you?' } });
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    expect(writeNote).toHaveBeenCalledWith(ref.key, expect.anything(), { text: '@Aaron Abbot can you?', mentions: ['ab'] });
    useTeamNamesStore.setState({ lists: {}, directory: {} });
  });

  it('puts the caret after a kept draft when the field is focused again', async () => {
    const { NoteField } = await import('../note-field');
    const { createRef } = await import('react');
    const handle = createRef<import('../note-field').NoteFieldHandle>();
    render(<NoteField ref={handle} value="half written" onChange={() => {}} onSubmit={() => {}} onClose={() => {}} />);
    const field = screen.getByLabelText('field_label') as HTMLTextAreaElement;
    field.setSelectionRange(0, 0);
    act(() => handle.current!.focus());
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe('half written'.length);
  });

  it('never sends while an input method is composing', () => {
    seed([]);
    render(<Conversation />);
    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    const field = screen.getByLabelText('field_label');
    fireEvent.change(field, { target: { value: '日本' } });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(writeNote).not.toHaveBeenCalled();
  });

  it('gives a read-only member no Note button, and one sentence where notes are', () => {
    seed([note('a', '2026-11-20T10:00:00Z', 'my job')], { canWrite: false });
    const view = render(<Conversation />);
    expect(screen.getByText('read_only_member')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'note' })).toBeNull();
    expect(screen.queryByLabelText('field_label')).toBeNull();
    view.unmount();
    // Without notes there is nothing to say.
    seed([], { canWrite: false });
    const { container } = render(<Conversation />);
    expect(container.querySelector('[data-team-note-area]')!.textContent).toBe('');
  });

  it('gives no Note button in an account shared read-only, even before the notes have loaded', () => {
    teamContext = { ref, client: { ...client, getAccountInfo: () => ({ isReadOnly: true }) } };
    seed([], { canWrite: null });
    render(<Conversation />);
    expect(screen.queryByRole('button', { name: 'note' })).toBeNull();
  });

  it('keeps the field open and its text when a reply joins the conversation', () => {
    seed([]);
    const view = render(<Conversation />);
    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    fireEvent.change(screen.getByLabelText('field_label'), { target: { value: 'half written' } });
    view.rerender(<Conversation messages={[m1, m2, message('m3', '2026-11-20T15:00:00Z')]} />);
    expect((screen.getByLabelText('field_label') as HTMLTextAreaElement).value).toBe('half written');
  });

  it('puts the text of a note that could not be saved back into the field with Edit', () => {
    seed([], {
      pending: { l1: { localId: 'l1', key: 'm2@client.example', threadId: 't1', text: 'mailbox full', mentions: [], at: Date.now(), status: 'error', error: 'overQuota' } },
    });
    render(<Conversation />);
    const card = document.querySelector('[data-team-note-pending="l1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'edit' }));
    expect(document.querySelector('[data-team-note-pending]')).toBeNull();
    expect((screen.getByLabelText('field_label') as HTMLTextAreaElement).value).toBe('mailbox full');
  });

  it('loads the notes again once the browser is back online', () => {
    seed([], { status: 'offline' });
    render(<Conversation />);
    expect(reloadTeam).toHaveBeenCalledWith(ref.key);
  });

  it('keeps a note that could not be saved, with the reason and Retry', () => {
    seed([], {
      pending: { l1: { localId: 'l1', key: 'm2@client.example', threadId: 't1', text: 'lost?', mentions: [], at: Date.now(), status: 'error', error: 'failed' } },
    });
    render(<Conversation />);
    const card = document.querySelector('[data-team-note-pending="l1"]') as HTMLElement;
    expect(within(card).getByText('lost?')).toBeTruthy();
    expect(within(card).getByText('save_failed')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'retry' })).toBeTruthy();
  });

  it('says when the notes could not be loaded, with Retry', () => {
    seed([], { status: 'error' });
    render(<Conversation />);
    expect(screen.getByRole('alert').textContent).toContain('load_failed');
  });
});
