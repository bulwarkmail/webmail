import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import { resetTeamNames, mergeTeamPeople } from '@/lib/team-mailboxes/names';
import { MEMBER_KEY, parseNote } from '@/lib/team-mailboxes/note-format';
import { ensureTeamLoaded, registerMember, resetTeamMailboxStore, useTeamMailboxStore } from '../team-mailbox-store';
import { FakeTeamServer, GROUP } from './helpers/fake-team-server';

// Where the server keeps no names list (Stalwart 0.16), a member says "I am
// in this team" once with a member entry in the notes folder, so the others
// can @ and assign them before they wrote a note.

const ref: TeamRef = { key: `login|${GROUP}`, loginId: 'login', accountId: GROUP, groupAddress: 'tm-team@example.org' };
const kinds = (server: FakeTeamServer) => [...server.notes.values()].map((n) => n.create['header:X-Bulwark-Note-Kind:asText']);

async function loaded(server = new FakeTeamServer(), client: IJMAPClient = server.client()) {
  server.addNotesFolder();
  await ensureTeamLoaded(ref, client);
  return { server, client };
}

beforeEach(() => {
  resetTeamMailboxStore();
  resetTeamNames();
});
afterEach(() => {
  resetTeamMailboxStore();
  resetTeamNames();
});

describe('member entries', () => {
  it('writes one entry about no message, with the user\'s id, once', async () => {
    const { server } = await loaded();
    expect(await registerMember(ref.key)).toBe(true);
    expect(await registerMember(ref.key)).toBe(false);
    expect(kinds(server)).toEqual(['member']);
    const stored = [...server.notes.values()][0].create;
    expect(stored['header:X-Bulwark-Note-For:asText']).toBe(`<${MEMBER_KEY}>`);
    expect(stored['header:X-Bulwark-Note-Author:asText']).toBe('me');
    // Its author is a person the others can pick, with an id.
    const notes = Object.values(useTeamMailboxStore.getState().teams[ref.key].notes);
    expect(mergeTeamPeople({ self: null, notes }).people).toEqual([{ id: 'me', name: 'Alice Archer', email: 'tm-alice@example.org' }]);
  });

  it('writes nothing when a note of the user already names their id', async () => {
    const server = new FakeTeamServer();
    server.addNote({
      mailboxIds: { notes: true }, from: [{ name: 'Alice Archer', email: 'tm-alice@example.org' }], subject: 'Note: Offer',
      'header:X-Bulwark-Note-For:asText': '<m1@client.example>', 'header:X-Bulwark-Note-Kind:asText': 'note',
      'header:X-Bulwark-Note-Author:asText': 'me',
    });
    await loaded(server);
    expect(await registerMember(ref.key)).toBe(false);
    expect(kinds(server)).toEqual(['note']);
  });

  it('writes nothing where the server keeps a names list, or the user may only read', async () => {
    const withMetadata = new FakeTeamServer();
    const client = withMetadata.client();
    Object.assign(client, { supportsBulwarkMetadata: () => true });
    await loaded(withMetadata, client);
    expect(await registerMember(ref.key)).toBe(false);
    expect(withMetadata.notes.size).toBe(0);

    resetTeamMailboxStore();
    const reader = new FakeTeamServer();
    reader.addNotesFolder();
    reader.setReadOnly();
    await ensureTeamLoaded(ref, reader.client());
    expect(await registerMember(ref.key)).toBe(false);
    expect(reader.notes.size).toBe(0);
  });

  it('keeps member entries out of every conversation', () => {
    const entry = parseNote({
      id: 'n1', receivedAt: '2026-11-21T10:00:00Z', from: [{ name: 'Bob', email: 'bob@example.org' }],
      'header:X-Bulwark-Note-For:asText': `<${MEMBER_KEY}>`, 'header:X-Bulwark-Note-Kind:asText': 'member',
    });
    expect(entry).toMatchObject({ kind: 'member', key: MEMBER_KEY, threadId: null, text: '' });
  });
});
