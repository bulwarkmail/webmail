import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNoteEmail } from '@/lib/team-mailboxes/note-format';
import { emitPushStateChange } from '@/lib/push-events';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import {
  NOTES_INDEX_CAP,
  applyChanges,
  baseSubject,
  deleteNote,
  ensureTeamLoaded,
  loadConversation,
  notesOf,
  onNotesArrived,
  pendingOf,
  repairOriginalKeywords,
  resetTeamMailboxStore,
  retryNote,
  useTeamMailboxStore,
  writeNote,
} from '../team-mailbox-store';
import { FakeTeamServer, GROUP } from './helpers/fake-team-server';

const ref: TeamRef = { key: `login|${GROUP}`, loginId: 'login', accountId: GROUP, groupAddress: 'tm-team@example.org' };
const bob = { name: 'Bob Baker', email: 'tm-bob@example.org' };
const DAY = 86_400_000;

function bobNote(server: FakeTeamServer, key: string, text: string, extra: Partial<Parameters<typeof buildNoteEmail>[0]> = {}, at?: number) {
  const { email } = buildNoteEmail({
    mailboxId: 'notes', author: bob, groupAddress: ref.groupAddress, subject: 'Offer for the Mulberry project',
    key, threadId: 't1', kind: 'note', text, ...extra,
  });
  return server.addNote(email, new Date(at ?? Date.now()).toISOString());
}

const team = () => useTeamMailboxStore.getState().teams[ref.key];
const target = { emailId: 'mail-1', key: 'orig-1@client.example', threadId: 't1', subject: 'Offer for the Mulberry project' };

beforeEach(() => resetTeamMailboxStore());
afterEach(() => resetTeamMailboxStore());

describe('loading a team', () => {
  it('indexes the notes of the last 90 days without their text, and knows who writes', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const recent = bobNote(server, 'orig-1@client.example', 'my job');
    bobNote(server, 'orig-2@client.example', 'old', {}, Date.now() - 120 * DAY);

    await ensureTeamLoaded(ref, server.client());

    const t = team();
    expect(t.status).toBe('ready');
    expect(Object.keys(t.notes)).toEqual([recent]);
    expect(t.notes[recent].text).toBeUndefined();
    expect(t.author).toEqual({ name: 'Alice Archer', email: 'tm-alice@example.org' });
    expect(t.canWrite).toBe(true);
    expect(server.calls).not.toContain('getTeamNotes:text');
  });

  it('reaches back only as far as the newest notes when there are more than the cap', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const now = Date.now();
    for (let i = 0; i < NOTES_INDEX_CAP + 3; i += 1) bobNote(server, `k${i}`, 'x', {}, now - i * 60_000);
    await ensureTeamLoaded(ref, server.client());
    expect(Object.keys(team().notes)).toHaveLength(NOTES_INDEX_CAP);
    expect(team().windowStart).toBe(now - (NOTES_INDEX_CAP - 1) * 60_000);
  });

  it('says a read-only member cannot write', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    server.setReadOnly();
    await ensureTeamLoaded(ref, server.client());
    expect(team().canWrite).toBe(false);
  });

  it('says the notes could not be loaded instead of showing none', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const client = server.client();
    client.queryTeamNotes = vi.fn(async () => { throw new Error('boom'); });
    await ensureTeamLoaded(ref, client);
    expect(team().status).toBe('error');
  });
});

describe('writing notes', () => {
  it('makes the folder on the first note, shared like the Inbox, and marks the message', async () => {
    const server = new FakeTeamServer();
    await ensureTeamLoaded(ref, server.client());
    expect(team().folderIds).toEqual([]);

    const id = await writeNote(ref.key, target, { text: ' waiting for Mabel ', mentions: ['HV'] });

    expect(server.folders.find((f) => f.id === 'notes')?.shareWith).toEqual({ reader: { mayReadItems: true } });
    const stored = server.notes.get(id!)!.create;
    expect(stored.from).toEqual([{ name: 'Alice Archer', email: 'tm-alice@example.org' }]);
    expect(stored['header:X-Bulwark-Note-For:asText']).toBe('<orig-1@client.example>');
    expect(team().notes[id!]).toMatchObject({ text: 'waiting for Mabel', mentions: ['hv'], kind: 'note' });
    expect(pendingOf(team(), [target.key])).toEqual([]);
    await vi.waitFor(() => expect(server.keywordPatches).toEqual([
      { ids: ['mail-1'], patch: { 'keywords/$bulwark-notes': true, 'keywords/$bulwark-mention-hv': true } },
    ]));
  });

  it('keeps a note that could not be saved, with the reason, and Retry saves it', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    await ensureTeamLoaded(ref, server.client());
    server.failNextCreate = 'overQuota';

    expect(await writeNote(ref.key, target, { text: 'my job' })).toBeNull();
    const [failed] = pendingOf(team(), [target.key]);
    expect(failed).toMatchObject({ status: 'error', error: 'overQuota', text: 'my job' });

    const id = await retryNote(ref.key, failed.localId, target);
    expect(id).toBeTruthy();
    expect(pendingOf(team(), [target.key])).toEqual([]);
    expect(notesOf(team(), [target.key], []).map((n) => n.text)).toEqual(['my job']);
  });

  it('turns the field off when the server refuses the write', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    await ensureTeamLoaded(ref, server.client());
    server.failNextCreate = 'forbidden';
    await writeNote(ref.key, target, { text: 'x' });
    expect(team().canWrite).toBe(false);
    expect(pendingOf(team(), [target.key])[0].error).toBe('forbidden');
  });

  it('writes a timeline entry without text and without mention keywords on the message', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    await ensureTeamLoaded(ref, server.client());
    const id = await writeNote(ref.key, target, { kind: 'assigned', mentions: ['hv'] });
    expect(team().notes[id!]).toMatchObject({ kind: 'assigned', text: '', mentions: ['hv'] });
    expect(server.notes.get(id!)!.create.keywords).toEqual({ $seen: true, '$bulwark-note': true });
    expect(server.keywordPatches).toEqual([]);
  });
});

describe('live updates', () => {
  it('shows another member\'s note with its text, and drops one they deleted', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const client = server.client();
    await ensureTeamLoaded(ref, client);
    const arrived = vi.fn();
    onNotesArrived(arrived);

    server.touchMail('mail-9');
    const id = bobNote(server, target.key, 'passed this to Josh');
    emitPushStateChange({ '@type': 'StateChange', changed: { [GROUP]: { Email: server.state } } }, client, 'active');

    await vi.waitFor(() => expect(team().notes[id]?.text).toBe('passed this to Josh'));
    expect(Object.keys(team().notes)).toEqual([id]);
    expect(arrived).toHaveBeenCalledWith(ref, client, [expect.objectContaining({ id, text: 'passed this to Josh' })]);

    server.removeNote(id);
    await applyChanges(ref.key);
    expect(team().notes[id]).toBeUndefined();
  });

  it('ignores pushes for other accounts and other clients', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const client = server.client();
    await ensureTeamLoaded(ref, client);
    bobNote(server, target.key, 'x');
    emitPushStateChange({ '@type': 'StateChange', changed: { other: { Email: 's9' } } }, client, 'active');
    emitPushStateChange({ '@type': 'StateChange', changed: { [GROUP]: { Email: 's9' } } }, new FakeTeamServer().client(), 'active');
    await new Promise((r) => setTimeout(r, 10));
    expect(Object.keys(team().notes)).toEqual([]);
  });
});

describe('a conversation', () => {
  it('loads the text of its notes and finds notes older than the index by subject', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const old = bobNote(server, target.key, 'from last year', {}, Date.now() - 300 * DAY);
    bobNote(server, 'other@x', 'another conversation', { subject: 'Offer for something else' }, Date.now() - 300 * DAY);
    const recent = bobNote(server, target.key, 'still waiting');
    await ensureTeamLoaded(ref, server.client());
    expect(Object.keys(team().notes)).toEqual([recent]);

    await loadConversation(ref.key, [
      { id: 'mail-1', messageId: ['<orig-1@client.example>'], threadId: 't1', subject: 'Re: Offer for the Mulberry project', receivedAt: new Date(Date.now() - 301 * DAY).toISOString() },
    ], [target.key]);

    expect(notesOf(team(), [target.key], ['t1']).map((n) => [n.id, n.text])).toEqual([[old, 'from last year'], [recent, 'still waiting']]);
  });

  it('strips reply prefixes for the subject lookup', () => {
    expect(baseSubject('Re: AW: Fwd: Offer')).toBe('Offer');
    expect(baseSubject('Offer: the details')).toBe('Offer: the details');
  });
});

describe('the filter keywords on the message', () => {
  it('adds what its notes need and removes what no note backs any more', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    bobNote(server, target.key, 'ask @mabel', { mentions: ['hw'] });
    await ensureTeamLoaded(ref, server.client());

    await repairOriginalKeywords(ref.key, [
      { id: 'mail-1', key: target.key, keywords: { $seen: true } },
      { id: 'mail-2', key: 'gone@x', keywords: { '$bulwark-notes': true, '$bulwark-mention-hv': true } },
    ]);

    expect(server.keywordPatches).toEqual([
      { ids: ['mail-1'], patch: { 'keywords/$bulwark-notes': true, 'keywords/$bulwark-mention-hw': true } },
      { ids: ['mail-2'], patch: { 'keywords/$bulwark-notes': null, 'keywords/$bulwark-mention-hv': null } },
    ]);
  });
});

describe('deleting', () => {
  it('deletes the user\'s own note and Undo brings it back the same', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    await ensureTeamLoaded(ref, server.client());
    const id = (await writeNote(ref.key, target, { text: 'my job' }))!;
    const messageId = team().notes[id].messageId;

    const undo = await deleteNote(ref.key, id);
    expect(server.notes.has(id)).toBe(false);
    expect(team().notes[id]).toBeUndefined();

    expect(await undo!()).toBe(true);
    const [back] = notesOf(team(), [target.key], []);
    expect(back).toMatchObject({ text: 'my job', messageId });
    expect(server.notes.get(back.id)!.create.subject).toBe('Note: Offer for the Mulberry project');
  });

  it('never deletes someone else\'s note', async () => {
    const server = new FakeTeamServer();
    server.addNotesFolder();
    const id = bobNote(server, target.key, 'Bob\'s');
    await ensureTeamLoaded(ref, server.client());
    expect(await deleteNote(ref.key, id)).toBeNull();
    expect(server.notes.has(id)).toBe(true);
    expect(server.calls).not.toContain('destroyTeamNote');
  });
});
