import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import { resetTeamNames } from '@/lib/team-mailboxes/names';
import {
  assign,
  assignToMe,
  ensureTeamLoaded,
  markDone,
  notesOf,
  reopen,
  resetTeamMailboxStore,
  unassign,
  useTeamMailboxStore,
} from '../team-mailbox-store';
import { FakeTeamServer, GROUP } from './helpers/fake-team-server';

const ref: TeamRef = { key: `login|${GROUP}`, loginId: 'login', accountId: GROUP, groupAddress: 'tm-team@example.org' };
const email = {
  id: 'mail-1', messageId: ['<orig-1@client.example>'], threadId: 't1', subject: 'Offer for the Mulberry project',
  keywords: { $seen: true, '$assigned:ci': true } as Record<string, boolean>,
};
const team = () => useTeamMailboxStore.getState().teams[ref.key];
const entries = () => notesOf(team(), ['orig-1@client.example'], ['t1']).map((n) => ({ kind: n.kind, mentions: n.mentions }));

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

describe('assigning', () => {
  it('assigns to one person in one keyword write on the team\'s account, then writes the timeline line', async () => {
    const { server } = await loaded();
    const result = await assign(ref.key, email, 'CJ', { name: 'Josh Jones', email: 'josh@example.org' });

    expect(server.keywordPatches).toEqual([
      { ids: ['mail-1'], patch: { 'keywords/$assigned:ci': null, 'keywords/$assigned:cj': true } },
    ]);
    expect(result).toMatchObject({ kind: 'assigned', changed: true, assignee: { id: 'cj', name: 'Josh Jones', me: false } });
    expect(result.keywords).toEqual({ $seen: true, '$assigned:cj': true });
    const entryId = await result.timeline;
    expect(entryId).toBeTruthy();
    expect(entries()).toEqual([{ kind: 'assigned', mentions: ['cj'] }]);
    expect(server.notes.get(entryId!)!.create['header:X-Bulwark-Note-For:asText']).toBe('<orig-1@client.example>');
  });

  it('assigns to me with my own principal id, and says it was me', async () => {
    const { server } = await loaded();
    const result = await assignToMe(ref.key, email);
    expect(server.keywordPatches[0].patch).toEqual({ 'keywords/$assigned:ci': null, 'keywords/$assigned:me': true });
    expect(result.assignee).toEqual({ id: 'me', name: 'Alice Archer', me: true });
    await result.timeline;
    expect(entries()).toEqual([{ kind: 'assigned', mentions: ['me'] }]);
  });

  it('rejects when the message can\'t be changed, and writes no timeline line', async () => {
    const server = new FakeTeamServer();
    const client = server.client();
    client.batchUpdateKeywords = vi.fn(async () => { throw new Error('forbidden'); });
    await loaded(server, client);
    await expect(markDone(ref.key, email)).rejects.toThrow('forbidden');
    expect(server.calls).not.toContain('createTeamNote');
  });

  it('keeps the assignment when the timeline line can\'t be written', async () => {
    const { server } = await loaded();
    server.failNextCreate = 'serverFail';
    const result = await assign(ref.key, email, 'cj');
    expect(await result.timeline).toBeNull();
    expect(server.keywordPatches).toHaveLength(1);
    expect(result.changed).toBe(true);
  });

  it('writes nothing when the message already is that way', async () => {
    const { server } = await loaded();
    const result = await reopen(ref.key, email);
    expect(result.changed).toBe(false);
    expect(server.keywordPatches).toEqual([]);
    expect(server.calls).not.toContain('createTeamNote');
  });

  it('unassigns, marks done and reopens, each with its line', async () => {
    const { server } = await loaded();
    await (await unassign(ref.key, email)).timeline;
    await (await markDone(ref.key, email)).timeline;
    await (await reopen(ref.key, { ...email, keywords: { $done: true } })).timeline;
    expect(server.keywordPatches.map((p) => p.patch)).toEqual([
      { 'keywords/$assigned:ci': null },
      { 'keywords/$done': true },
      { 'keywords/$done': null },
    ]);
    expect(entries().map((e) => e.kind)).toEqual(['unassigned', 'done', 'reopened']);
    expect(entries().every((e) => e.mentions.length === 0)).toBe(true);
  });

  it('names the assignee from the names list when the caller doesn\'t', async () => {
    const server = new FakeTeamServer();
    const client = server.client();
    Object.assign(client, {
      supportsBulwarkMetadata: () => true,
      getBulwarkMetadata: async () => ({ team: { v: 1, people: { cj: { n: 'Josh Jones', e: 'josh@example.org' } } } }),
      setBulwarkMetadata: vi.fn(async () => {}),
    });
    await loaded(server, client);
    const { loadTeamNames } = await import('@/lib/team-mailboxes/names');
    await loadTeamNames(ref, client);
    const result = await assign(ref.key, email, 'cj');
    expect(result.assignee?.name).toBe('Josh Jones');
  });

  it('adds the assignee and the user to the names list', async () => {
    const server = new FakeTeamServer();
    const client = server.client();
    const setBulwarkMetadata = vi.fn(async () => {});
    Object.assign(client, { supportsBulwarkMetadata: () => true, getBulwarkMetadata: async () => ({}), setBulwarkMetadata });
    await loaded(server, client);
    await assign(ref.key, email, 'cj', { name: 'Josh Jones', email: 'josh@example.org' });
    await vi.waitFor(() => expect(setBulwarkMetadata).toHaveBeenCalled());
    expect(setBulwarkMetadata).toHaveBeenCalledWith(GROUP, 'team', {
      v: 1, people: { me: { n: 'Alice Archer', e: 'tm-alice@example.org' }, cj: { n: 'Josh Jones', e: 'josh@example.org' } },
    });
  });

  it('assigns even when the names list can\'t be written', async () => {
    const server = new FakeTeamServer();
    const client = server.client();
    Object.assign(client, {
      supportsBulwarkMetadata: () => true,
      getBulwarkMetadata: async () => { throw new Error('panic'); },
      setBulwarkMetadata: async () => { throw new Error('panic'); },
    });
    await loaded(server, client);
    const result = await assign(ref.key, email, 'cj', { name: 'Josh', email: 'josh@example.org' });
    expect(result.changed).toBe(true);
    expect(server.keywordPatches).toHaveLength(1);
  });
});

describe('undo', () => {
  it('puts the keywords back and takes the timeline line away', async () => {
    const { server } = await loaded();
    const result = await assign(ref.key, email, 'cj', { name: 'Josh', email: 'josh@example.org' });
    const entryId = await result.timeline;
    await result.undo();
    expect(server.keywordPatches[1]).toEqual({ ids: ['mail-1'], patch: { 'keywords/$assigned:ci': true, 'keywords/$assigned:cj': null } });
    expect(server.notes.has(entryId!)).toBe(false);
    expect(entries()).toEqual([]);
  });

  it('writes the opposite line when the line can\'t be taken away', async () => {
    const server = new FakeTeamServer();
    const client = server.client();
    client.destroyTeamNote = vi.fn(async () => { throw new Error('gone'); });
    await loaded(server, client);
    const result = await markDone(ref.key, email);
    await result.timeline;
    await result.undo();
    expect(entries().map((e) => e.kind)).toEqual(['done', 'reopened']);
  });

  it('gives the message back to whoever had it when the line can\'t be taken away', async () => {
    const server = new FakeTeamServer();
    const client = server.client();
    client.destroyTeamNote = vi.fn(async () => { throw new Error('gone'); });
    await loaded(server, client);
    const result = await assign(ref.key, email, 'cj');
    await result.timeline;
    await result.undo();
    expect(entries()).toEqual([{ kind: 'assigned', mentions: ['cj'] }, { kind: 'assigned', mentions: ['ci'] }]);
  });

  it('rejects when the keywords can\'t be written back', async () => {
    const server = new FakeTeamServer();
    const client = server.client();
    await loaded(server, client);
    const result = await markDone(ref.key, email);
    client.batchUpdateKeywords = vi.fn(async () => { throw new Error('offline'); });
    await expect(result.undo()).rejects.toThrow('offline');
  });
});
