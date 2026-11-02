import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_LIST_CAP,
  buildRestoreCalls,
  classifyArchiveError,
  hasArchivedEmail,
  listArchivedEmailsPaged,
  parseArchivedFrom,
  parseArchivedItems,
  readRestoreResults,
  visibleArchivedItems,
  type ArchiveIo,
} from '../archived-items';
import { jmapError } from '@/lib/jmap/jmap-error';
import { ACCOUNT, ARCHIVED_FILE, LICENSE_REFUSAL, archivedEmail, bigArchive, fakeArchiveServer } from './fixtures';

const NOW = Date.parse('2026-10-28T12:00:00Z');

/** An ArchiveIo over the derived server, counting what it is asked. */
function ioFor(items: Array<Record<string, unknown>>) {
  const server = fakeArchiveServer(items);
  const asked = { queries: 0, gets: 0 };
  const io: ArchiveIo = {
    query: async (position, limit) => {
      asked.queries++;
      const [[, result]] = server.answer({ methodCalls: [['x:ArchivedItem/query', { accountId: ACCOUNT, position, limit, calculateTotal: true }, 'q']] }).methodResponses;
      return { ids: result.ids as string[], total: result.total as number };
    },
    get: async (ids) => {
      asked.gets++;
      const [[, result]] = server.answer({ methodCalls: [['x:ArchivedItem/get', { accountId: ACCOUNT, ids }, 'g']] }).methodResponses;
      return result.list as unknown[];
    },
  };
  return { io, asked };
}

describe('parseArchivedFrom', () => {
  it('reads the three forms the server stores', () => {
    expect(parseArchivedFrom('Org Bob <org-bob@example.org>')).toEqual({ name: 'Org Bob', email: 'org-bob@example.org' });
    expect(parseArchivedFrom('org-bob@example.org')).toEqual({ name: '', email: 'org-bob@example.org' });
    expect(parseArchivedFrom('Org Bob')).toEqual({ name: 'Org Bob', email: '' });
    expect(parseArchivedFrom('')).toEqual({ name: '', email: '' });
  });
});

describe('parseArchivedItems', () => {
  it('keeps deleted messages with sender, subject and dates, and leaves other kinds out', () => {
    const items = parseArchivedItems([archivedEmail('a'), ARCHIVED_FILE, archivedEmail('b', { from: 'carol@example.org', subject: '' })], ACCOUNT);
    expect(items).toEqual([
      {
        id: 'a', fromName: 'Org Bob', fromEmail: 'org-bob@example.org', subject: 'Message a',
        receivedAt: '2026-10-01T09:00:00Z', archivedAt: '2026-10-20T08:00:00Z', archivedUntil: '2026-11-19T08:00:00Z',
        size: 2048, accountId: ACCOUNT,
      },
      expect.objectContaining({ id: 'b', fromName: '', fromEmail: 'carol@example.org', subject: '' }),
    ]);
  });

  it('drops malformed entries instead of failing', () => {
    expect(parseArchivedItems([null, 'x', { '@type': 'Email' }, archivedEmail('c', { archivedAt: 'yesterday' })], ACCOUNT)).toEqual([]);
    expect(parseArchivedItems(undefined, ACCOUNT)).toEqual([]);
  });

  it("drops items that name another account from a mixed answer", () => {
    const items = parseArchivedItems([
      archivedEmail('a'),
      archivedEmail('z', { accountId: 'cz' }),
      archivedEmail('e', { accountId: '' }),
    ], ACCOUNT);
    expect(items.map((i) => i.id)).toEqual(['a']);
  });

  it('keeps items without accountId, as the server sends them to a regular user (#1480)', () => {
    const { accountId: _owner, ...stripped } = archivedEmail('n');
    const items = parseArchivedItems([stripped], ACCOUNT);
    expect(items).toEqual([expect.objectContaining({ id: 'n', subject: 'Message n', accountId: ACCOUNT })]);
  });
});

describe('visibleArchivedItems', () => {
  const items = parseArchivedItems([
    archivedEmail('old', { archivedAt: '2026-10-01T08:00:00Z' }),
    archivedEmail('new', { archivedAt: '2026-10-27T08:00:00Z' }),
    archivedEmail('mid', { archivedAt: '2026-10-20T08:00:00Z' }),
    archivedEmail('gone', { archivedAt: '2026-10-26T08:00:00Z', archivedUntil: '2026-10-27T08:00:00Z' }),
  ], ACCOUNT);

  it('lists everything the server still keeps, newest deletion first, with days 0', () => {
    expect(visibleArchivedItems(items, 0, NOW).map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });

  it('limits the list to the last N days', () => {
    expect(visibleArchivedItems(items, 10, NOW).map((i) => i.id)).toEqual(['new', 'mid']);
    expect(visibleArchivedItems(items, 2, NOW).map((i) => i.id)).toEqual(['new']);
    expect(visibleArchivedItems(items, 1, NOW)).toEqual([]);
  });
});

describe('listArchivedEmailsPaged', () => {
  it('reads newest first in pages of 500 and stops after 2000 with where Show older goes on', async () => {
    const { io, asked } = ioFor(bigArchive(6000, NOW));
    const first = await listArchivedEmailsPaged(io, ACCOUNT, { days: 0, now: NOW });
    expect(asked.queries).toBe(ARCHIVE_LIST_CAP / 500);
    expect(first.nextPosition).toBe(2000);
    // The newest item (past the 5000 an unpaged query would stop at) comes first; files are left out.
    expect(first.items[0].id).toBe('i006000');
    expect(first.items).toHaveLength(1600);

    const second = await listArchivedEmailsPaged(io, ACCOUNT, { days: 0, now: NOW, startPosition: first.nextPosition! });
    expect(second.nextPosition).toBe(4000);
    const third = await listArchivedEmailsPaged(io, ACCOUNT, { days: 0, now: NOW, startPosition: second.nextPosition! });
    expect(third.nextPosition).toBeNull();
    const all = [...first.items, ...second.items, ...third.items];
    expect(all).toHaveLength(4800);
    expect(all[all.length - 1].id).toBe('i000002');
  });

  it('stops once a whole page is older than the days window', async () => {
    // Item n was deleted n minutes ago: one day is items 0-1440, 1153 of them messages.
    const { io, asked } = ioFor(bigArchive(6000, NOW));
    const result = await listArchivedEmailsPaged(io, ACCOUNT, { days: 1, now: NOW });
    expect(result.nextPosition).toBeNull();
    // Pages 1-3 hold items inside the day, page 4 (1500-1999) is the first wholly older one.
    expect(asked.queries).toBe(4);
    expect(result.items.every((i) => Date.parse(i.archivedAt) >= NOW - 86_400_000)).toBe(true);
    expect(result.items).toHaveLength(1153);
  });

  it('ends at the last page', async () => {
    const { io, asked } = ioFor(bigArchive(30, NOW));
    const result = await listArchivedEmailsPaged(io, ACCOUNT, { days: 0, now: NOW });
    expect(result).toMatchObject({ nextPosition: null });
    expect(result.items).toHaveLength(24);
    expect(asked.queries).toBe(1);
  });
});

describe('hasArchivedEmail', () => {
  it('looks one item at a time and stops at the first message inside the window', async () => {
    const { io, asked } = ioFor([
      { ...ARCHIVED_FILE, id: 'i3', archivedAt: '2026-10-28T11:00:00Z' },
      archivedEmail('i2', { archivedAt: '2026-10-28T10:00:00Z', archivedUntil: '2026-11-28T10:00:00Z' }),
      archivedEmail('i1', { archivedAt: '2026-10-28T09:00:00Z', archivedUntil: '2026-11-28T10:00:00Z' }),
    ]);
    await expect(hasArchivedEmail(io, ACCOUNT, { days: 7, now: NOW })).resolves.toBe(true);
    expect(asked).toEqual({ queries: 2, gets: 2 });
  });

  it('says no at the first item older than the window', async () => {
    const { io, asked } = ioFor([archivedEmail('i1', { archivedAt: '2026-09-01T09:00:00Z', archivedUntil: '2026-11-28T10:00:00Z' })]);
    await expect(hasArchivedEmail(io, ACCOUNT, { days: 7, now: NOW })).resolves.toBe(false);
    expect(asked.queries).toBe(1);
  });

  it('says no for an archive of files only, after its limit', async () => {
    const files = Array.from({ length: 50 }, (_, n) => ({ ...ARCHIVED_FILE, id: `i${String(n).padStart(3, '0')}`, archivedAt: '2026-10-28T11:00:00Z' }));
    const { io, asked } = ioFor(files);
    await expect(hasArchivedEmail(io, ACCOUNT, { days: 0, now: NOW, limit: 5 })).resolves.toBe(false);
    expect(asked.queries).toBe(5);
  });
});

describe('restore calls', () => {
  it('asks for requestRestore per item, split at maxObjectsInSet', () => {
    const calls = buildRestoreCalls(['a', 'b', 'c'], ACCOUNT, 2);
    expect(calls).toEqual([
      ['x:ArchivedItem/set', { accountId: ACCOUNT, update: { a: { status: 'requestRestore' }, b: { status: 'requestRestore' } } }, 'r0'],
      ['x:ArchivedItem/set', { accountId: ACCOUNT, update: { c: { status: 'requestRestore' } } }, 'r1'],
    ]);
  });

  it('reports every item: restored, refused with the reason and type, or failed with its call', () => {
    const calls = buildRestoreCalls(['a', 'b', 'c'], ACCOUNT, 2);
    const results = readRestoreResults(calls, [
      ['x:ArchivedItem/set', { updated: { a: null }, notUpdated: { b: { type: 'notFound' } } }, 'r0'],
      ['error', LICENSE_REFUSAL, 'r1'],
    ]);
    expect(results).toEqual([
      { id: 'a', ok: true },
      { id: 'b', ok: false, error: 'notFound', type: 'notFound' },
      { id: 'c', ok: false, error: LICENSE_REFUSAL.description, type: 'forbidden' },
    ]);
  });

  it('fails the items of a call the answer leaves out', () => {
    const calls = buildRestoreCalls(['a'], ACCOUNT, 10);
    expect(readRestoreResults(calls, [])).toEqual([{ id: 'a', ok: false, error: 'No answer' }]);
  });
});

describe('classifyArchiveError', () => {
  it('counts a refusal by the server as unsupported and anything else as an error', () => {
    expect(classifyArchiveError(jmapError(LICENSE_REFUSAL.description, LICENSE_REFUSAL))).toBe('unsupported');
    expect(classifyArchiveError(jmapError('x', { type: 'unknownMethod' }))).toBe('unsupported');
    expect(classifyArchiveError(new Error('Request failed: 400 - {"type":"urn:ietf:params:jmap:error:unknownCapability"}'))).toBe('unsupported');
    expect(classifyArchiveError(new Error('Failed to fetch'))).toBe('error');
    expect(classifyArchiveError(jmapError('x', { type: 'serverFail' }))).toBe('error');
  });
});
