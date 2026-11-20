import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { NoteEntry } from '../note-format';
import type { TeamRef } from '../team';
import {
  LOOKUP_MIN_GAP_MS,
  MAX_NAMES_BYTES,
  PLUGIN_NAMES_KEY,
  TEAM_NAMES_KEY,
  addToTeamNames,
  findByEmail,
  loadTeamNames,
  lookUpNames,
  mergeNames,
  mergeTeamPeople,
  namesFromEntries,
  readNames,
  registerSelf,
  resetTeamNames,
  searchDirectory,
  shortName,
  useTeamNamesStore,
  writeNames,
} from '../names';

vi.mock('@/lib/directory-scope', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/directory-scope')>();
  return { ...real, directoryScopeFor: vi.fn(async () => null), loadScopedPrincipalDirectory: vi.fn() };
});
const scope = await import('@/lib/directory-scope');

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** A group Inbox's shared metadata, as getBulwarkMetadata hands it back (keys without org.bulwarkmail.). */
function metadataClient(entries: Record<string, unknown> | null, extra: Partial<Record<keyof IJMAPClient, unknown>> = {}) {
  const store = entries ? { ...entries } : null;
  const writes: Array<{ accountId: string | undefined; key: string; value: unknown }> = [];
  const client = {
    getUsername: () => 'tm-alice@example.org',
    getAccountId: () => 'CA',
    getIdentities: async () => [{ id: 'i1', name: 'Alice Archer', email: 'tm-alice@example.org' }],
    getAccountInfo: () => ({ name: 'tm-team@example.org', isPersonal: false, isReadOnly: false, accountCapabilities: {} }),
    supportsBulwarkMetadata: () => store !== null,
    getBulwarkMetadata: vi.fn(async () => (store ? { ...store } : null)),
    setBulwarkMetadata: vi.fn(async (accountId: string | undefined, key: string, value: unknown) => {
      writes.push({ accountId, key, value });
      if (store) store[key] = value;
    }),
    supportsPrincipals: () => true,
    ...extra,
  } as unknown as IJMAPClient;
  return { client, writes, store };
}

beforeEach(() => resetTeamNames());
afterEach(() => {
  vi.useRealTimers();
  resetTeamNames();
});

describe('the names list', () => {
  it('reads what it wrote, and nothing else', () => {
    const people = { cj: { name: 'Org Bob', email: 'org-bob@example.org' } };
    expect(readNames(writeNames(people))).toEqual(people);
    expect(writeNames(people)).toEqual({ v: 1, people: { cj: { n: 'Org Bob', e: 'org-bob@example.org' } } });
    expect(readNames(null)).toEqual({});
    expect(readNames({ people: { 'a b': { n: 'X' }, ok: { n: '\u0007Eve', e: 'EVE@EXAMPLE.ORG' }, empty: {} } }))
      .toEqual({ ok: { name: 'Eve', email: 'eve@example.org' } });
  });

  it('says when merging changes nothing, and moves a changed person to the end', () => {
    const map = { cj: { name: 'Org Bob', email: 'org-bob@example.org' }, ck: { name: 'Carol', email: 'carol@example.org' } };
    expect(mergeNames(map, { cj: { name: 'Org Bob', email: 'org-bob@example.org' } })).toBeNull();
    const next = mergeNames(map, { cj: { name: 'Bob Baker', email: 'org-bob@example.org' } });
    expect(Object.keys(next!)).toEqual(['ck', 'cj']);
    expect(next!.cj.name).toBe('Bob Baker');
  });

  it('drops the oldest people until the list is under 3.5 KB, however long the names', () => {
    const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`p${i}`, { name: `Person ${i}`, email: `p${i}@example.org` }]));
    const value = writeNames(many);
    expect(bytes(value)).toBeLessThan(MAX_NAMES_BYTES);
    expect(value.people.p0).toBeUndefined();
    expect(value.people.p119).toEqual({ n: 'Person 119', e: 'p119@example.org' });
    const long = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`q${i}`, { name: 'Ä'.repeat(80), email: `q${i}@example.org` }]));
    expect(bytes(writeNames(long))).toBeLessThan(MAX_NAMES_BYTES);
  });

  it('reads the plugin\'s list and core\'s, core winning per id', () => {
    expect(PLUGIN_NAMES_KEY).toBe('plugin.team-inbox');
    expect(TEAM_NAMES_KEY).toBe('team');
    const names = namesFromEntries({
      'plugin.team-inbox': { v: 1, people: { cj: { n: 'Old Bob', e: 'bob@example.org' }, ck: { n: 'Carol', e: 'carol@example.org' } } },
      team: { v: 1, people: { cj: { n: 'Bob Baker', e: 'bob@example.org' } } },
      tags: { v: 1, people: { zz: { n: 'Not a name' } } },
    });
    expect(names).toEqual({ ck: { name: 'Carol', email: 'carol@example.org' }, cj: { name: 'Bob Baker', email: 'bob@example.org' } });
  });
});

describe('names on chips', () => {
  it('shows a first name, or the local part of an address', () => {
    expect(shortName({ name: 'Org Bob', email: 'org-bob@example.org' })).toBe('Org');
    expect(shortName({ name: 'org-bob@example.org', email: '' })).toBe('org-bob');
    expect(shortName(null)).toBe('');
  });

  it('finds a person by address', () => {
    expect(findByEmail({ cj: { name: 'Bob', email: 'bob@example.org' } }, ' BOB@example.org ')).toEqual({ id: 'cj', name: 'Bob', email: 'bob@example.org' });
    expect(findByEmail({}, 'x@y.z')).toBeNull();
  });
});

describe('reading and writing the list on the server', () => {
  it('writes only under core\'s key, with the plugin\'s people kept', async () => {
    const { client, writes } = metadataClient({
      'plugin.team-inbox': { v: 1, people: { ck: { n: 'Carol', e: 'carol@example.org' } } },
    });
    expect(await addToTeamNames(ref, client, { cj: { name: 'Bob', email: 'bob@example.org' } })).toBe(true);
    expect(writes).toEqual([{
      accountId: 'g', key: 'team',
      value: { v: 1, people: { ck: { n: 'Carol', e: 'carol@example.org' }, cj: { n: 'Bob', e: 'bob@example.org' } } },
    }]);
    expect(useTeamNamesStore.getState().lists[ref.key]).toMatchObject({ cj: { name: 'Bob' }, ck: { name: 'Carol' } });
  });

  it('doesn\'t write a list that didn\'t change, and reads it again right before writing', async () => {
    const { client, writes, store } = metadataClient({ team: { v: 1, people: { cj: { n: 'Bob', e: 'bob@example.org' } } } });
    await loadTeamNames(ref, client);
    // Another member added Carol since.
    store!.team = { v: 1, people: { cj: { n: 'Bob', e: 'bob@example.org' }, ck: { n: 'Carol', e: 'carol@example.org' } } };
    expect(await addToTeamNames(ref, client, { cj: { name: 'Bob', email: 'bob@example.org' } })).toBe(false);
    expect(writes).toEqual([]);
    await addToTeamNames(ref, client, { cm: { name: 'Mabel', email: 'mabel@example.org' } });
    expect(Object.keys((writes[0].value as { people: object }).people)).toEqual(['cj', 'ck', 'cm']);
  });

  it('never fails because of names: no metadata, a failed read, a failed write', async () => {
    const none = metadataClient(null);
    expect(await addToTeamNames(ref, none.client, { cj: { name: 'Bob', email: 'bob@example.org' } })).toBe(false);
    expect(await loadTeamNames(ref, none.client)).toBeNull();

    const failingRead = metadataClient({}, { getBulwarkMetadata: vi.fn(async () => { throw new Error('panic'); }) });
    await expect(addToTeamNames(ref, failingRead.client, { cj: { name: 'Bob', email: 'b@x.org' } })).resolves.toBe(false);

    const failingWrite = metadataClient({}, { setBulwarkMetadata: vi.fn(async () => { throw new Error('tooLarge'); }) });
    await expect(addToTeamNames(ref, failingWrite.client, { cj: { name: 'Bob', email: 'b@x.org' } })).resolves.toBe(false);
  });

  it('adds the user to the list the first time they open the team mailbox, once', async () => {
    const { client, writes } = metadataClient({});
    await registerSelf(ref, client);
    await registerSelf(ref, client);
    expect(writes).toEqual([{ accountId: 'g', key: 'team', value: { v: 1, people: { ca: { n: 'Alice Archer', e: 'tm-alice@example.org' } } } }]);
  });

  it('doesn\'t write the user again when the list already has them', async () => {
    const { client, writes } = metadataClient({ team: { v: 1, people: { ca: { n: 'Alice Archer', e: 'tm-alice@example.org' } } } });
    await registerSelf(ref, client);
    expect(writes).toEqual([]);
  });

  it('keeps no list where the server has no metadata (0.16)', async () => {
    const { client } = metadataClient(null);
    await registerSelf(ref, client);
    expect(client.getBulwarkMetadata).not.toHaveBeenCalled();
    expect(client.setBulwarkMetadata).not.toHaveBeenCalled();
  });
});

describe('the people of a team', () => {
  const note = (over: Partial<NoteEntry>): NoteEntry => ({
    id: 'n', messageId: null, key: 'k', threadId: null, kind: 'note', author: { name: 'Mabel Moss', email: 'mabel@example.org' },
    at: 1, mentions: [], ...over,
  });

  it('puts the user first, then the list, note authors and assignees, then the directory', () => {
    const people = mergeTeamPeople({
      self: { id: 'CA', name: 'Alice Archer', email: 'tm-alice@example.org' },
      list: { cj: { name: 'Bob Baker', email: 'bob@example.org' } },
      notes: [
        note({ id: 'n1', at: 2 }),
        note({ id: 'n2', at: 3, kind: 'assigned', mentions: ['cx'], author: { name: 'Bob B.', email: 'bob@example.org' } }),
      ],
      directory: { cx: { name: 'Xavier', email: 'x@example.org' }, cj: { name: 'Directory Bob', email: 'bob@example.org' } },
    });
    expect(people.selfId).toBe('ca');
    expect(people.people).toEqual([
      { id: 'ca', name: 'Alice Archer', email: 'tm-alice@example.org' },
      { id: 'cj', name: 'Bob Baker', email: 'bob@example.org' },
      { id: 'cx', name: 'Xavier', email: 'x@example.org' },
      { id: null, name: 'Mabel Moss', email: 'mabel@example.org' },
    ]);
    expect(people.byId('CX')?.name).toBe('Xavier');
    expect(people.recent).toEqual(['cx']);
  });

  it('gives a note author an id when the directory knows their address', () => {
    const people = mergeTeamPeople({
      self: null,
      notes: [note({})],
      directory: { cm: { name: 'Mabel M.', email: 'mabel@example.org' } },
    });
    expect(people.people).toEqual([{ id: 'cm', name: 'Mabel Moss', email: 'mabel@example.org' }]);
  });

  it('keeps an assignee nobody named, without a name', () => {
    const people = mergeTeamPeople({ self: null, notes: [note({ kind: 'assigned', mentions: ['zz'] })] });
    expect(people.byId('zz')).toEqual({ id: 'zz', name: '', email: '' });
  });

  it('ranks recent assignees by how often, without the user', () => {
    const people = mergeTeamPeople({
      self: { id: 'ca', name: 'A', email: 'a@x.org' },
      notes: [
        note({ id: '1', kind: 'assigned', mentions: ['ck'] }),
        note({ id: '2', kind: 'assigned', mentions: ['cj'] }),
        note({ id: '3', kind: 'assigned', mentions: ['cj'] }),
        note({ id: '4', kind: 'assigned', mentions: ['ca'] }),
      ],
    });
    expect(people.recent).toEqual(['cj', 'ck']);
  });
});

describe('the directory', () => {
  const principals = [
    { id: 'cj', type: 'individual', name: 'bob', description: 'Bob Baker', email: 'bob@example.org' },
    { id: 'g', type: 'group', name: 'tm-team', email: 'tm-team@example.org' },
    { id: 'cm', type: 'individual', name: 'mabel', description: 'Mabel Moss', email: 'mabel@example.org' },
  ];

  it('searches from 3 characters, without groups', async () => {
    vi.mocked(scope.loadScopedPrincipalDirectory).mockResolvedValue({ principals, status: 'ok' } as never);
    const { client } = metadataClient(null);
    expect(await searchDirectory(client, 'ba')).toEqual([]);
    expect(await searchDirectory(client, 'BAK')).toEqual([{ id: 'cj', name: 'Bob Baker', email: 'bob@example.org' }]);
    expect(await searchDirectory(client, 'tm-team')).toEqual([]);
  });

  it('finds no one where the server doesn\'t allow directory lookups', async () => {
    vi.mocked(scope.loadScopedPrincipalDirectory).mockResolvedValue({ principals, status: 'restricted' } as never);
    const { client } = metadataClient(null);
    expect(await searchDirectory(client, 'bob')).toEqual([]);
  });

  it('looks names up by id in batches of 20, at most one lookup every 10 seconds, each id once', async () => {
    vi.useFakeTimers();
    const getAccountOwners = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { id, type: 'individual', name: id, description: `Name ${id}`, email: `${id}@example.org` }])));
    const { client } = metadataClient(null, { getAccountOwners });
    const ids = Array.from({ length: 25 }, (_, i) => `p${i}`);
    lookUpNames('login', client, ids);
    lookUpNames('login', client, ids);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getAccountOwners).toHaveBeenCalledTimes(1);
    expect(getAccountOwners.mock.calls[0][0]).toHaveLength(20);
    expect(useTeamNamesStore.getState().directory.login.p0).toEqual({ name: 'Name p0', email: 'p0@example.org' });
    await vi.advanceTimersByTimeAsync(LOOKUP_MIN_GAP_MS - 1000);
    expect(getAccountOwners).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getAccountOwners).toHaveBeenCalledTimes(2);
    expect(getAccountOwners.mock.calls[1][0]).toEqual(['p20', 'p21', 'p22', 'p23', 'p24']);
    lookUpNames('login', client, ['p3']);
    await vi.advanceTimersByTimeAsync(LOOKUP_MIN_GAP_MS * 2);
    expect(getAccountOwners).toHaveBeenCalledTimes(2);
  });

  it('leaves out people the admin\'s directory rules hide', async () => {
    vi.useFakeTimers();
    vi.mocked(scope.directoryScopeFor).mockResolvedValueOnce({ ownDomains: ['example.org'], hiddenLocalparts: [] });
    const getAccountOwners = vi.fn(async () => ({
      cj: { id: 'cj', type: 'individual', name: 'bob', description: 'Bob', email: 'bob@example.org' },
      cx: { id: 'cx', type: 'individual', name: 'x', description: 'Outsider', email: 'x@elsewhere.org' },
    }));
    const { client } = metadataClient(null, { getAccountOwners });
    lookUpNames('login', client, ['cj', 'cx']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useTeamNamesStore.getState().directory.login).toEqual({ cj: { name: 'Bob', email: 'bob@example.org' } });
  });
});
