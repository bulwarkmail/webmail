import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import {
  HiddenFolderRegistry,
  hiddenFolderClause,
  isTeamNotesFolder,
  splitHiddenFolders,
  withoutHiddenFolders,
} from '../hidden-folders';

// The team notes folder of a group account never shows in Bulwark; its ids
// are remembered so queries without a folder leave its messages out.

describe('isTeamNotesFolder', () => {
  it('is the root folder named "Team notes" without a role in an account other than the own', () => {
    expect(isTeamNotesFolder({ name: 'Team notes' }, false)).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(isTeamNotesFolder({ name: 'Team notes' }, true)).toBe(false);
    expect(isTeamNotesFolder({ name: 'Team notes', parentId: 'p' }, false)).toBe(false);
    expect(isTeamNotesFolder({ name: 'Team notes', role: 'archive' }, false)).toBe(false);
    expect(isTeamNotesFolder({ name: 'team notes' }, false)).toBe(false);
    expect(isTeamNotesFolder({ name: 'Inbox', role: 'inbox' }, false)).toBe(false);
  });
});

describe('splitHiddenFolders and withoutHiddenFolders', () => {
  const raw = [
    { id: 'a', name: 'Inbox', role: 'inbox' },
    { id: 'n', name: 'Team notes' },
    { id: 'c', name: 'Team notes', parentId: 'a' },
  ];

  it('splits a shared account list into what shows and the hidden ids', () => {
    const { visible, hiddenIds } = splitHiddenFolders(raw, false);
    expect(visible.map((f) => f.id)).toEqual(['a', 'c']);
    expect(hiddenIds).toEqual(['n']);
  });

  it('keeps the own account whole', () => {
    expect(splitHiddenFolders(raw, true)).toEqual({ visible: raw, hiddenIds: [] });
  });

  it('drops the folder from a mapped list (boot snapshot)', () => {
    const mapped = [
      { id: 'g:n', name: 'Team notes', isShared: true },
      { id: 'own-n', name: 'Team notes', isShared: false },
    ];
    expect(withoutHiddenFolders(mapped).map((f) => f.id)).toEqual(['own-n']);
  });
});

describe('hiddenFolderClause', () => {
  it('always leaves notes out by keyword, and by folder once the ids are known', () => {
    expect(hiddenFolderClause()).toEqual({ notKeyword: '$bulwark-note' });
    expect(hiddenFolderClause(['n'])).toEqual({
      operator: 'AND', conditions: [{ notKeyword: '$bulwark-note' }, { inMailboxOtherThan: ['n'] }],
    });
  });
});

describe('HiddenFolderRegistry', () => {
  it('keeps ids per account, replaced by full lists and added to by partial ones', () => {
    const registry = new HiddenFolderRegistry();
    registry.setAll('g1', ['n']);
    registry.add('g1', ['m']);
    registry.setAll('g2', ['x']);
    expect(registry.ids('g1').sort()).toEqual(['m', 'n']);
    expect(registry.has('g2', 'x')).toBe(true);
    expect(registry.has('g1', 'x')).toBe(false);
    registry.setAll('g1', []);
    expect(registry.ids('g1')).toEqual([]);
  });
});

type MethodCall = [string, Record<string, unknown>, string];
type RequestTarget = { request(calls: MethodCall[]): Promise<unknown> };

function clientWith(folders: Record<string, Array<Record<string, unknown>>>): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'me',
    username: 'user@example.com',
    accounts: { me: { name: 'user@example.com', isPersonal: true }, team: { name: 'team@example.com', isPersonal: false } },
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
  });
  vi.spyOn(client as unknown as RequestTarget, 'request').mockImplementation(async (calls) => ({
    methodResponses: calls.map(([, args, tag]) => {
      const all = folders[args.accountId as string] ?? [];
      const ids = args.ids as string[] | undefined;
      return ['Mailbox/get', { list: ids ? all.filter((f) => ids.includes(f.id as string)) : all, state: 's1' }, tag];
    }),
  }));
  return client;
}

const folders = {
  me: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }, { id: 'mine', name: 'Team notes' }],
  team: [{ id: 'g-inbox', name: 'Inbox', role: 'inbox' }, { id: 'g-notes', name: 'Team notes' }],
};

describe('JMAPClient folder lists', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves the team notes folder out of every list and remembers its id', async () => {
    const client = clientWith(folders);

    const all = await client.getAllMailboxes();
    expect(all.map((m) => m.id)).toEqual(['inbox', 'mine', 'team:g-inbox']);
    expect(client.hiddenMailboxIds('team')).toEqual(['g-notes']);
    expect(client.hiddenMailboxIds()).toEqual([]);

    const one = await client.getMailboxes('team');
    expect(one.map((m) => m.id)).toEqual(['g-inbox']);

    const byIds = await client.getMailboxesByIds(['g-inbox', 'g-notes'], 'team');
    expect(byIds.map((m) => m.originalId)).toEqual(['g-inbox']);
  });

  it('hands the folder to export, import and the notes store when asked', async () => {
    const client = clientWith(folders);
    const raw = await client.getMailboxes('team', { includeHidden: true });
    expect(raw.map((m) => m.name)).toEqual(['Inbox', 'Team notes']);
    expect(client.hiddenMailboxIds('team')).toEqual(['g-notes']);
  });
});
