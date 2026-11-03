// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCOPE } from '@/lib/store/area';
import { AccountEngine } from '@/lib/store/engine/account-engine';
import { mailArea } from '@/lib/store/mail';
import { FAKE_SESSION, FakeJmap, JMAP_ACCOUNT } from '@/lib/store/__tests__/helpers/fake-jmap';
import { openMemoryStore } from '@/lib/store/__tests__/helpers/node-adapter';
import { JMAPClient } from '../client';
import type { SearchEmailsResult } from '../client-interface';
import { setOfflineHooks, type OfflineHooks } from '../offline-hooks';
import { filterHasTextTerms, LocalSearchMerge, mailboxesFitFilter } from '../search-merge';
import type { Email } from '../types';

function mail(id: string, minute: number, extra: Partial<Email> = {}): Email {
  return { id, receivedAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(), ...extra } as Email;
}

/** A side of the search: the whole result list, answered a page at a time, newest first. */
function side(rows: Email[], fixedTotal?: number) {
  const asked: number[] = [];
  const answer = async (position: number, limit: number): Promise<SearchEmailsResult> => {
    asked.push(position);
    const total = fixedTotal ?? rows.length;
    const emails = rows.slice(position, position + limit);
    return { emails, total, hasMore: position + emails.length < total };
  };
  return { asked, answer };
}

function pager(server: ReturnType<typeof side>, local: ReturnType<typeof side> | null, limit: number) {
  const merge = new LocalSearchMerge();
  return (position: number) => merge.run({
    key: 'search',
    limit,
    position,
    server: (at) => server.answer(at, limit),
    local: async (at) => (local ? local.answer(at, limit) : null),
  });
}

const ids = (result: SearchEmailsResult) => result.emails.map((email) => email.id);

describe('merging one page', () => {
  it('sorts newest first and has no duplicates', async () => {
    const server = side([mail('s4', 40), mail('both3', 30), mail('s1', 10)]);
    const local = side([mail('l5', 50), mail('both3', 30), mail('l2', 20)]);
    const result = await pager(server, local, 50)(0);
    expect(ids(result)).toEqual(['l5', 's4', 'both3', 'l2', 's1']);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(5);
  });

  it('keeps the server copy when both have a message', async () => {
    const server = side([mail('both', 10, { subject: 'server copy' })]);
    const local = side([mail('both', 10, { subject: 'local copy' })]);
    const result = await pager(server, local, 50)(0);
    expect(result.emails.map((email) => email.subject)).toEqual(['server copy']);
    expect(result.total).toBe(1);
  });

  it('keeps the server copy when the local row sorts earlier than it', async () => {
    // The local copy is out of date and looks newer: still one row, the server's.
    const server = side([mail('s2', 20), mail('both', 10, { subject: 'server copy' })]);
    const local = side([mail('both', 30, { subject: 'local copy' })]);
    const result = await pager(server, local, 50)(0);
    expect(ids(result)).toEqual(['s2', 'both']);
    expect(result.emails[1].subject).toBe('server copy');
  });

  it('passes on what the server added to its result, such as its deferred snippets', async () => {
    const snippets = Promise.resolve([]);
    const merge = new LocalSearchMerge();
    const result = await merge.run({
      key: 'k', limit: 10, position: 0,
      server: async () => ({ emails: [mail('s', 1)], total: 1, hasMore: false, snippets }),
      local: async () => ({ emails: [mail('l', 2)], total: 1, hasMore: false }),
    });
    expect(result.snippets).toBe(snippets);
  });
});

describe('paging', () => {
  it('walks both lists with no row lost or repeated, counting by merged rows', async () => {
    const serverRows = Array.from({ length: 25 }, (_, i) => mail(`s${i}`, 1000 - i * 10));
    const localOnly = [mail('l-a', 995), mail('l-b', 905), mail('l-c', 805), mail('l-d', 500)];
    const server = side(serverRows);
    const local = side([...localOnly, serverRows[1], serverRows[12]].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)));
    const page = pager(server, local, 10);

    const seen: string[] = [];
    let result = await page(0);
    seen.push(...ids(result));
    expect(result.emails.length).toBe(10);
    expect(result.hasMore).toBe(true);
    let guard = 0;
    while (result.hasMore && guard < 10) {
      // As the store does: the next position is how many rows it holds.
      result = await page(seen.length);
      seen.push(...ids(result));
      guard += 1;
    }
    expect(seen.length).toBe(29);
    expect(new Set(seen).size).toBe(29);
    expect(seen).toEqual(expect.arrayContaining([...serverRows.map((e) => e.id), ...localOnly.map((e) => e.id)]));
    const times = [...serverRows, ...localOnly].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).map((e) => e.id);
    expect(seen).toEqual(times);
    expect(result.total).toBe(29);
  });

  it('asks the server for rows a local row pushed off the page', async () => {
    const server = side([mail('s3', 30), mail('s2', 20), mail('s1', 10)]);
    const local = side([mail('l4', 40)]);
    const page = pager(server, local, 2);
    expect(ids(await page(0))).toEqual(['l4', 's3']);
    expect(server.asked).toEqual([0]);
    // Merged position 2, but the server has only given one row so far.
    expect(ids(await page(2))).toEqual(['s2', 's1']);
    expect(server.asked).toEqual([0, 1]);
  });

  it('holds back a local row older than what the server has sent, in case the server has it later', async () => {
    const serverRows = [mail('s4', 40), mail('s3', 30), mail('both', 20), mail('s1', 10)];
    const server = side(serverRows);
    const local = side([mail('both', 20)]);
    const page = pager(server, local, 2);
    const first = await page(0);
    expect(ids(first)).toEqual(['s4', 's3']);
    const second = await page(2);
    expect(ids(second)).toEqual(['both', 's1']);
    expect(second.hasMore).toBe(false);
    expect(second.total).toBe(4);
  });

  it('keeps paging through local rows when the server has none', async () => {
    const server = side([]);
    const local = side([mail('l3', 30), mail('l2', 20), mail('l1', 10)]);
    const page = pager(server, local, 2);
    const first = await page(0);
    expect(ids(first)).toEqual(['l3', 'l2']);
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(3);
    const second = await page(2);
    expect(ids(second)).toEqual(['l1']);
    expect(second.hasMore).toBe(false);
    expect(second.total).toBe(3);
  });

  it('keeps total at or above what has been returned and what either side knows of', async () => {
    const server = side([mail('s2', 20), mail('s1', 10)], 40);
    const local = side([mail('l3', 30)], 50);
    const result = await pager(server, local, 2)(0);
    expect(result.total).toBe(50);
    const noLocalLead = await pager(side([mail('s2', 20)], 40), side([mail('l3', 30)], 1), 2)(0);
    expect(noLocalLead.total).toBe(41);
  });

  it('never repeats a local row the server later returns', async () => {
    // Same time on both sides, split by the page edge: it shows once.
    const server = side([mail('s', 20), mail('tie', 20)]);
    const local = side([mail('tie', 20), mail('l', 5)]);
    const page = pager(server, local, 1);
    const seen = [...ids(await page(0))];
    seen.push(...ids(await page(seen.length)));
    seen.push(...ids(await page(seen.length)));
    expect(seen).toEqual(['s', 'tie', 'l']);
  });

  it('drops a row the server returns later if the store already showed it, and holds older local rows until the server catches up', async () => {
    // The local copy of x looks newer than the server's, so it goes out first.
    const server = side([mail('a', 30), mail('b', 25), mail('x', 20), mail('c', 10)]);
    const local = side([mail('x', 40), mail('l', 5)]);
    const page = pager(server, local, 2);
    const first = await page(0);
    expect(ids(first)).toEqual(['x', 'a']);
    // The server's page is b and x. x has been shown, and the server has more,
    // so l can't be placed yet: it may be on the server's next page.
    const second = await page(2);
    expect(ids(second)).toEqual(['b']);
    expect(second.hasMore).toBe(true);
    const third = await page(3);
    expect(ids(third)).toEqual(['c', 'l']);
    expect(third.hasMore).toBe(false);
  });

  it('follows a caller whose position has moved since the last page', async () => {
    const server = side([mail('s4', 40), mail('s3', 30), mail('s2', 20), mail('s1', 10)]);
    const local = side([mail('l5', 50)]);
    const page = pager(server, local, 2);
    await page(0);
    // The caller added a row of its own to the list, as plugins can: one past.
    await page(3);
    expect(server.asked).toEqual([0, 2]);
  });

  it('starts over at position 0', async () => {
    const server = side([mail('s2', 20), mail('s1', 10)]);
    const local = side([mail('l3', 30)]);
    const page = pager(server, local, 2);
    await page(0);
    expect(ids(await page(0))).toEqual(['l3', 's2']);
  });

  it('walks a search again when it has no cursor, so no server row is skipped', async () => {
    const server = side([mail('s4', 40), mail('s3', 30), mail('s2', 20), mail('s1', 10)]);
    const local = side([mail('l5', 50), mail('l25', 25)]);
    const merge = new LocalSearchMerge();
    const ask = (key: string, position: number) => merge.run({
      key, limit: 2, position,
      server: (at) => server.answer(at, 2),
      local: (at) => local.answer(at, 2),
    });
    // The caller holds l5, s4, s3. As a merged position 3 would skip s2 on the server.
    const result = await ask('evicted', 3);
    expect(ids(result)).toEqual(['l25', 's2']);
  });

  it('sends a position with no cursor straight to the server when the store is off', async () => {
    const server = side([mail('s2', 20), mail('s1', 10)]);
    const result = await pager(server, null, 2)(1);
    expect(ids(result)).toEqual(['s1']);
    expect(server.asked).toEqual([0, 1]);
  });

  it('ends the list, and never guesses, past how far it will walk again', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => mail(`s${i}`, 1000 - i));
    const server = side(rows);
    const local = side([mail('l', 2000)]);
    const result = await pager(server, local, 2)(90);
    expect(result.emails).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(server.asked).not.toContain(90);
  });

  describe('a refresh of a longer list', () => {
    function paged() {
      const serverRows = [mail('s6', 60), mail('s5', 50), mail('s4', 40), mail('s3', 30), mail('s2', 20), mail('s1', 10)];
      const server = side(serverRows);
      const local = side([mail('l7', 70)]);
      return { server, local, page: pager(server, local, 2) };
    }

    it('leaves the next load-more where the list had got to', async () => {
      const { page } = paged();
      await page(0);
      await page(2);
      const refreshed = await page(0);
      expect(ids(refreshed)).toEqual(['l7', 's6']);
      const more = await page(4);
      expect(ids(more)).toEqual(['s3', 's2']);
    });

    it('keeps total the same when nothing changed', async () => {
      const { page } = paged();
      const first = await page(0);
      expect(first.total).toBe(7);
      await page(2);
      expect((await page(0)).total).toBe(7);
    });

    it('does not forget a local row that was on a later page', async () => {
      const server = side([mail('s6', 60), mail('s5', 50), mail('s4', 40), mail('s3', 30), mail('s2', 20), mail('s1', 10)]);
      const local = side([mail('l45', 45)]);
      const page = pager(server, local, 2);
      expect(ids(await page(0))).toEqual(['s6', 's5']);
      expect(ids(await page(2))).toEqual(['l45', 's4']);
      // This first page has no local row, so it knows nothing of l45 by itself.
      const refreshed = await page(0);
      expect(ids(refreshed)).toEqual(['s6', 's5']);
      expect(refreshed.total).toBe(7);
      // The list holds four rows, three of them the server's: s3 is next.
      const more = await page(4);
      expect(ids(more)).toEqual(['s3', 's2']);
      expect(more.total).toBe(7);
    });

    it('still lets a new search of the same words page from its own start', async () => {
      const { page } = paged();
      await page(0);
      await page(2);
      await page(0);
      // The list was replaced by that page, so the next one starts right after it.
      expect(ids(await page(2))).toEqual(['s5', 's4']);
    });

    it('moves on past a new row the refresh brought in', async () => {
      const serverRows = [mail('s4', 40), mail('s3', 30), mail('s2', 20), mail('s1', 10)];
      const server = side(serverRows);
      const local = side([mail('l5', 50)]);
      const page = pager(server, local, 2);
      await page(0);
      await page(2);
      serverRows.unshift(mail('new', 60));
      const refreshed = await page(0);
      expect(refreshed.total).toBe(6);
      // The caller's list grew by one: l5 s4 s3 s2 plus the new row.
      expect(ids(await page(5))).toEqual(['s1']);
    });
  });

  describe('how long a cursor lasts', () => {
    function search(merge: LocalSearchMerge, key: string, position: number, rows: ReturnType<typeof side>, local: ReturnType<typeof side>) {
      return merge.run({ key, limit: 1, position, server: (at) => rows.answer(at, 1), local: (at) => local.answer(at, 1) });
    }
    const other = () => [side([mail('o', 1)]), side([])] as const;

    it('keeps the search in use when many others come and go', async () => {
      const merge = new LocalSearchMerge();
      const server = side([mail('s2', 20), mail('s1', 10)]);
      const local = side([mail('l3', 30)]);
      await search(merge, 'mine', 0, server, local);
      for (let i = 0; i < 60; i += 1) await search(merge, `other-${i}`, 0, ...other());
      await search(merge, 'mine', 1, server, local);
      for (let i = 60; i < 120; i += 1) await search(merge, `other-${i}`, 0, ...other());
      server.asked.length = 0;
      expect(ids(await search(merge, 'mine', 2, server, local))).toEqual(['s1']);
      // The cursor was there: no walking from the start again.
      expect(server.asked).toEqual([1]);
    });

    it('still returns the right rows once a cursor is gone', async () => {
      const merge = new LocalSearchMerge();
      const server = side([mail('s2', 20), mail('s1', 10)]);
      const local = side([mail('l3', 30)]);
      await search(merge, 'mine', 0, server, local);
      for (let i = 0; i < 70; i += 1) await search(merge, `other-${i}`, 0, ...other());
      expect(ids(await search(merge, 'mine', 1, server, local))).toEqual(['s2']);
    });
  });

  it('counts a row both sides have once in total', async () => {
    const server = side([mail('s1', 10)]);
    const local = side([mail('s1', 10)]);
    const result = await pager(server, local, 5)(0);
    expect(result.total).toBe(1);
  });

  it('keeps searches apart by key', async () => {
    const merge = new LocalSearchMerge();
    const server = (rows: Email[]) => async (at: number) => ({ emails: rows.slice(at, at + 1), total: rows.length, hasMore: at + 1 < rows.length });
    const a = { key: 'a', limit: 1, server: server([mail('a2', 20), mail('a1', 10)]), local: async () => ({ emails: [mail('la', 30)], total: 1, hasMore: false }) };
    const b = { key: 'b', limit: 1, server: server([mail('b1', 10)]), local: async () => null };
    expect(ids(await merge.run({ ...a, position: 0 }))).toEqual(['la']);
    expect(ids(await merge.run({ ...b, position: 0 }))).toEqual(['b1']);
    expect(ids(await merge.run({ ...a, position: 1 }))).toEqual(['a2']);
  });
});

describe('rows only the store has', () => {
  function run(
    serverRows: Email[],
    localRows: Email[],
    verify: (rows: Email[]) => Promise<Email[]>,
    limit = 5,
  ) {
    const server = side(serverRows);
    const local = side(localRows);
    return new LocalSearchMerge().run({
      key: 'k', limit, position: 0,
      server: (at) => server.answer(at, limit),
      local: (at) => local.answer(at, limit),
      verify,
    });
  }

  it('drops what the server no longer has, and fills the page with the rest', async () => {
    const verify = vi.fn(async (rows: Email[]) => rows.filter((row) => row.id !== 'deleted'));
    const result = await run([mail('s1', 10)], [mail('deleted', 30), mail('kept', 20)], verify);
    expect(ids(result)).toEqual(['kept', 's1']);
    expect(result.total).toBe(2);
    expect(verify.mock.calls[0][0].map((row) => row.id)).toEqual(['deleted', 'kept']);
  });

  it('shows the current copy of what the server still has', async () => {
    const result = await run([], [mail('kept', 20, { subject: 'old', keywords: {} })], async () => [mail('kept', 20, { subject: 'current', keywords: { $seen: true } })]);
    expect(result.emails[0].subject).toBe('current');
    expect(result.emails[0].keywords).toEqual({ $seen: true });
  });

  it('marks them, so nothing takes them for new mail', async () => {
    const result = await run([mail('s', 30)], [mail('s', 30), mail('kept', 20)], async (rows) => rows);
    expect(result.emails.map((email) => email.foundLocally ?? false)).toEqual([false, true]);
  });

  it('does not ask when the store has nothing of its own', async () => {
    const verify = vi.fn(async (rows: Email[]) => rows);
    await run([mail('both', 10)], [mail('both', 10)], verify);
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not ask about a row too old for this page', async () => {
    const verify = vi.fn(async (rows: Email[]) => rows);
    await run([mail('s3', 30), mail('s2', 20), mail('s1', 10)], [mail('old', 5)], verify, 2);
    expect(verify).not.toHaveBeenCalled();
  });

  it('keeps them when the check fails', async () => {
    const result = await run([mail('s1', 10)], [mail('kept', 20)], async () => { throw new Error('offline again'); });
    expect(ids(result)).toEqual(['kept', 's1']);
  });

  it('keeps them, unchecked, when the search itself failed', async () => {
    const verify = vi.fn(async () => []);
    const result = await new LocalSearchMerge().run({
      key: 'k', limit: 5, position: 0,
      server: async () => { throw new Error('server broke'); },
      local: async () => ({ emails: [mail('kept', 20)], total: 1, hasMore: false }),
      verify,
    });
    expect(ids(result)).toEqual(['kept']);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('mailboxesFitFilter', () => {
  const inbox = { inbox: true };
  it.each([
    [{ inMailbox: 'inbox' }, inbox, true],
    [{ inMailbox: 'inbox' }, { trash: true }, false],
    [{ inMailbox: 'inbox' }, { inbox: false }, false],
    [{ inMailbox: 'inbox' }, undefined, false],
    [{ inMailboxOtherThan: ['trash', 'junk'] }, inbox, true],
    [{ inMailboxOtherThan: ['trash', 'junk'] }, { trash: true }, false],
    [{ inMailboxOtherThan: ['trash', 'junk'] }, { trash: true, inbox: true }, true],
    [{ text: 'x' }, { trash: true }, true],
    [{ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { text: 'x' }] }, { trash: true }, false],
    [{ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { text: 'x' }] }, inbox, true],
    [{ operator: 'OR', conditions: [{ inMailbox: 'a' }, { inMailbox: 'b' }] }, { b: true }, true],
    [{ operator: 'OR', conditions: [{ inMailbox: 'a' }, { inMailbox: 'b' }] }, inbox, false],
    [{ operator: 'OR', conditions: [{ inMailbox: 'a' }, { text: 'x' }] }, inbox, true],
    [{ operator: 'NOT', conditions: [{ inMailbox: 'trash' }] }, inbox, true],
    [{ operator: 'NOT', conditions: [{ inMailbox: 'trash' }] }, { trash: true }, false],
    [{ operator: 'NOT', conditions: [{ text: 'x' }] }, inbox, true],
    [{ inMailbox: 'trash', text: 'x' }, inbox, false],
  ])('%j with %j is %s', (filter, boxes, expected) => {
    expect(mailboxesFitFilter(filter, boxes as Record<string, boolean> | undefined)).toBe(expected);
  });
});

describe('errors', () => {
  it('leaves no unhandled rejection when the store fails while the server is still working', async () => {
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', note);
    try {
      const result = await new LocalSearchMerge().run({
        key: 'k', limit: 10, position: 0,
        server: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { emails: [mail('s', 1)], total: 1, hasMore: false };
        },
        local: async () => { throw new Error('store broke'); },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ids(result)).toEqual(['s']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
    }
  });

  it('keeps the list open when the server fails on a later page', async () => {
    let fail = false;
    const rows = side([mail('s4', 40), mail('s3', 30), mail('s2', 20), mail('s1', 10)]);
    const local = side([mail('l5', 50), mail('l25', 25)]);
    const merge = new LocalSearchMerge();
    const run = (position: number) => merge.run({
      key: 'k', limit: 2, position,
      server: async (at) => {
        if (fail) throw new Error('server broke');
        return rows.answer(at, 2);
      },
      local: (at) => local.answer(at, 2),
    });
    expect((await run(0)).hasMore).toBe(true);
    fail = true;
    const during = await run(2);
    expect(ids(during)).toEqual(['l25']);
    // Local rows ran out, but the server said it had more: the list isn't over.
    expect(during.hasMore).toBe(true);
    fail = false;
    expect(ids(await run(3))).toEqual(['s3', 's2']);
  });

  it('keeps the server result when the store fails', async () => {
    const merge = new LocalSearchMerge();
    const result = await merge.run({
      key: 'k', limit: 10, position: 0,
      server: async () => ({ emails: [mail('s', 1)], total: 1, hasMore: false }),
      local: async () => { throw new Error('store broke'); },
    });
    expect(ids(result)).toEqual(['s']);
  });

  it('survives a store that fails before it can return a promise', async () => {
    const merge = new LocalSearchMerge();
    const result = await merge.run({
      key: 'k', limit: 10, position: 0,
      server: async () => ({ emails: [mail('s', 1)], total: 1, hasMore: false }),
      local: () => { throw new Error('store broke'); },
    });
    expect(ids(result)).toEqual(['s']);
  });

  it('keeps the local result when the server fails', async () => {
    const merge = new LocalSearchMerge();
    const result = await merge.run({
      key: 'k', limit: 10, position: 0,
      server: async () => { throw new Error('server broke'); },
      local: async () => ({ emails: [mail('l', 1)], total: 1, hasMore: false }),
    });
    expect(ids(result)).toEqual(['l']);
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('asks the server again on the next page after it failed', async () => {
    let fail = true;
    const server = side([mail('s1', 10)]);
    const merge = new LocalSearchMerge();
    const run = (position: number) => merge.run({
      key: 'k', limit: 1, position,
      server: async (at) => {
        if (fail) throw new Error('server broke');
        return server.answer(at, 1);
      },
      local: async (at) => side([mail('l2', 20), mail('l1', 5)]).answer(at, 1),
    });
    expect(ids(await run(0))).toEqual(['l2']);
    fail = false;
    expect(ids(await run(1))).toEqual(['s1']);
  });

  it('keeps the server error when the store has nothing to show', async () => {
    const failing = async () => { throw new Error('server broke'); };
    await expect(new LocalSearchMerge().run({
      key: 'k', limit: 10, position: 0, server: failing, local: async () => ({ emails: [], total: 0, hasMore: false }),
    })).rejects.toThrow('server broke');
    await expect(new LocalSearchMerge().run({
      key: 'k', limit: 10, position: 0, server: failing, local: async () => null,
    })).rejects.toThrow('server broke');
    await expect(new LocalSearchMerge().run({
      key: 'k', limit: 10, position: 0, server: failing, local: async () => { throw new Error('store broke too'); },
    })).rejects.toThrow('server broke');
  });

  it('keeps the error of a later page, so the user can try again', async () => {
    let fail = false;
    const merge = new LocalSearchMerge();
    const run = (position: number) => merge.run({
      key: 'k', limit: 1, position,
      server: async (at) => {
        if (fail) throw new Error('server broke');
        return side([mail('s2', 20), mail('s1', 10)]).answer(at, 1);
      },
      local: async (at) => side([mail('l3', 30)]).answer(at, 1),
    });
    expect(ids(await run(0))).toEqual(['l3']);
    fail = true;
    await expect(run(1)).rejects.toThrow('server broke');
    fail = false;
    expect(ids(await run(1))).toEqual(['s2']);
  });

  describe('with a store that never answers', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('counts the grace period from when the server answered', async () => {
      const merge = new LocalSearchMerge();
      let local: (value: SearchEmailsResult) => void = () => {};
      const answer = merge.run({
        key: 'k', limit: 10, position: 0,
        server: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return { emails: [mail('s', 1)], total: 1, hasMore: false };
        },
        local: () => new Promise((resolve) => { local = resolve; }),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      // The store answers soon after a slow server, and is still in time.
      await vi.advanceTimersByTimeAsync(500);
      local({ emails: [mail('l', 2)], total: 1, hasMore: false });
      expect(ids(await answer)).toEqual(['l', 's']);
    });

    it('waits only as long as it was told to', async () => {
      const merge = new LocalSearchMerge({ graceMs: 200 });
      let done = false;
      const answer = merge.run({
        key: 'k', limit: 10, position: 0,
        server: async () => ({ emails: [mail('s', 1)], total: 1, hasMore: false }),
        local: () => new Promise(() => {}),
      }).then((result) => {
        done = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(199);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ids(await answer)).toEqual(['s']);
    });

    it('does not hold the server result back for long', async () => {
      const merge = new LocalSearchMerge();
      const answer = merge.run({
        key: 'k', limit: 10, position: 0,
        server: async () => ({ emails: [mail('s', 1)], total: 1, hasMore: false }),
        local: () => new Promise(() => {}),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ids(await answer)).toEqual(['s']);
    });

    it('gives the server error once it has waited for the store', async () => {
      const merge = new LocalSearchMerge();
      const answer = merge.run({
        key: 'k', limit: 10, position: 0,
        server: async () => { throw new Error('server broke'); },
        local: () => new Promise(() => {}),
      });
      const failed = expect(answer).rejects.toThrow('server broke');
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
    });
  });
});

describe('filterHasTextTerms', () => {
  it('is true for searches for text, in any shape', () => {
    for (const filter of [
      { text: 'x' }, { from: 'x' }, { to: 'x' }, { cc: 'x' }, { bcc: 'x' }, { subject: 'x' }, { body: 'x' },
      { operator: 'AND', conditions: [{ inMailbox: 'i' }, { text: 'x' }] },
      { operator: 'OR', conditions: [{ to: 'x' }, { cc: 'x' }] },
      { operator: 'AND', conditions: [{ operator: 'OR', conditions: [{ hasKeyword: 'a' }, { body: 'x' }] }] },
    ]) expect(filterHasTextTerms(filter), JSON.stringify(filter)).toBe(true);
  });

  it('is false when nothing is searched for', () => {
    for (const filter of [
      {}, { inMailbox: 'i' }, { hasKeyword: '$seen' }, { text: '' }, { text: '  ' },
      { operator: 'AND', conditions: [{ inMailbox: 'i' }, { hasAttachment: true }] },
      { operator: 'NOT', conditions: [{ text: 'x' }] },
      { operator: 'AND', conditions: [] },
    ]) expect(filterHasTextTerms(filter), JSON.stringify(filter)).toBe(false);
  });
});

describe('through the client, with a real store', () => {
  const SERVER = 'https://mail.example.org';
  const SESSION = {
    apiUrl: `${SERVER}/jmap/`,
    downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${SERVER}/jmap/upload/{accountId}/`,
    accounts: { [JMAP_ACCOUNT]: { name: 'alice', isPersonal: true, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': JMAP_ACCOUNT },
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
    username: 'alice@example.org',
  };

  let serverRows: Array<Record<string, unknown>>;
  let serverFails: boolean;
  let requests: Array<Array<[string, Record<string, unknown>, string]>>;
  /** What Email/get by id finds on the server, past the search's own rows. */
  let serverKnows: Array<Record<string, unknown>>;

  function fakeServerFetch() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/.well-known/jmap')) return new Response(JSON.stringify(SESSION), { status: 200 });
      const { methodCalls } = JSON.parse(String(init?.body)) as { methodCalls: Array<[string, Record<string, unknown>, string]> };
      requests.push(methodCalls);
      if (serverFails) return new Response('broken', { status: 500 });
      const [firstName, firstArgs, firstId] = methodCalls[0];
      if (firstName === 'Email/get' && Array.isArray(firstArgs.ids)) {
        const wanted = firstArgs.ids as string[];
        const list = [...serverRows, ...serverKnows].filter((row) => wanted.includes(row.id as string));
        return new Response(JSON.stringify({
          methodResponses: [[firstName, { list, notFound: wanted.filter((id) => !list.some((row) => row.id === id)) }, firstId]],
        }), { status: 200 });
      }
      const position = (methodCalls[0][1].position as number) ?? 0;
      const limit = methodCalls[0][1].limit as number;
      const page = serverRows.slice(position, position + limit);
      return new Response(JSON.stringify({
        methodResponses: methodCalls.map(([name, , id]) => {
          if (name === 'Email/query') return [name, { ids: page.map((row) => row.id), total: serverRows.length, position }, id];
          if (name === 'Email/get') return [name, { list: page, notFound: [] }, id];
          return [name, { list: [], notFound: [] }, id];
        }),
      }), { status: 200 });
    });
  }

  async function storeEngine() {
    const fake = new FakeJmap();
    fake.addEmail({ id: 'both', subject: 'Stromrechnung', receivedAt: '2026-10-05T00:00:00Z' });
    fake.addEmail({ id: 'only-local', subject: 'Zahlungserinnerungsrechnung', receivedAt: '2026-10-03T00:00:00Z', mailboxIds: { inbox: true } });
    fake.addEmail({ id: 'not-a-hit', subject: 'Hallo', receivedAt: '2026-10-02T00:00:00Z' });
    const engine = new AccountEngine({
      account: 'a@fake.test',
      db: openMemoryStore(),
      session: FAKE_SESSION,
      transport: fake,
      areas: [mailArea],
      scope: { ...DEFAULT_SCOPE, days: null },
      now: () => Date.UTC(2026, 10, 3),
      sleep: async () => {},
    });
    await engine.requestSync();
    return engine;
  }

  function hooksWith(searchLocal: OfflineHooks['searchLocal'], skipNetwork = false): OfflineHooks {
    return {
      skipNetwork: () => skipNetwork,
      answer: async () => null,
      record: () => {},
      noteNetwork: () => {},
      serverGone: async () => false,
      blob: async () => null,
      recordBlob: () => {},
      holdUpload: async () => null,
      searchLocal,
    };
  }

  async function connected(): Promise<JMAPClient> {
    const client = new JMAPClient(SERVER, 'alice@example.org', 'pw');
    await client.connect();
    return client;
  }

  beforeEach(() => {
    serverFails = false;
    requests = [];
    serverKnows = [
      { id: 'only-local', subject: 'Zahlungserinnerungsrechnung', receivedAt: '2026-10-03T00:00:00Z', mailboxIds: { inbox: true } },
    ];
    serverRows = [
      { id: 'newer', subject: 'Rechnung', receivedAt: '2026-10-06T00:00:00Z', mailboxIds: { inbox: true } },
      { id: 'both', subject: 'Stromrechnung, server copy', receivedAt: '2026-10-05T00:00:00Z', mailboxIds: { inbox: true } },
    ];
    vi.stubGlobal('fetch', fakeServerFetch());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setOfflineHooks(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('merges what the store finds into searchEmails, with its highlights', async () => {
    const engine = await storeEngine();
    setOfflineHooks(hooksWith((_client, calls) => engine.answer(calls)));
    const client = await connected();
    const result = await client.searchEmails('rechnung');
    expect(result.emails.map((email) => email.id)).toEqual(['newer', 'both', 'only-local']);
    expect(result.emails[1].subject).toBe('Stromrechnung, server copy');
    expect(result.emails[2].searchSnippet?.subject).toBe('Zahlungserinnerungs<mark>rechnung</mark>');
    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(false);
  });

  it('drops a row deleted on the server since the store last synced', async () => {
    const engine = await storeEngine();
    setOfflineHooks(hooksWith((_client, calls) => engine.answer(calls)));
    serverKnows = [];
    const client = await connected();
    const result = await client.searchEmails('rechnung');
    expect(result.emails.map((email) => email.id)).toEqual(['newer', 'both']);
    expect(result.total).toBe(2);
  });

  it('drops a row moved out of the folder searched', async () => {
    const engine = await storeEngine();
    setOfflineHooks(hooksWith((_client, calls) => engine.answer(calls)));
    serverKnows = [{ id: 'only-local', subject: 'x', receivedAt: '2026-10-03T00:00:00Z', mailboxIds: { trash: true } }];
    const client = await connected();
    const inFolder = await client.searchEmails('rechnung', 'inbox');
    expect(inFolder.emails.map((email) => email.id)).toEqual(['newer', 'both']);
    const everywhere = await client.searchEmails('rechnung');
    expect(everywhere.emails.map((email) => email.id)).toEqual(['newer', 'both', 'only-local']);
    const notInTrash = await client.advancedSearchEmails({ operator: 'AND', conditions: [{ text: 'rechnung' }, { inMailboxOtherThan: ['trash'] }] });
    expect(notInTrash.emails.map((email) => email.id)).toEqual(['newer', 'both']);
  });

  it('searches the store without snippets, and asks only for those of its own rows', async () => {
    const engine = await storeEngine();
    const asked: string[][] = [];
    const snippetIds: unknown[] = [];
    setOfflineHooks(hooksWith((_client, calls) => {
      asked.push(calls.map(([name]) => name));
      for (const [name, args] of calls) if (name === 'SearchSnippet/get') snippetIds.push(args.emailIds);
      return engine.answer(calls);
    }));
    const client = await connected();
    await client.searchEmails('rechnung');
    expect(asked).toEqual([['Email/query', 'Email/get'], ['SearchSnippet/get']]);
    expect(snippetIds).toEqual([['only-local']]);
  });

  it('adds the snippets of its own rows to the deferred ones', async () => {
    const engine = await storeEngine();
    setOfflineHooks(hooksWith((_client, calls) => engine.answer(calls)));
    const client = await connected();
    const result = await client.searchEmails('rechnung', undefined, undefined, 50, 0, { deferSnippets: true });
    expect(result.emails.every((email) => !email.searchSnippet)).toBe(true);
    const snippets = await result.snippets;
    expect(snippets?.find((s) => s.emailId === 'only-local')?.subject).toBe('Zahlungserinnerungs<mark>rechnung</mark>');
  });

  it('keeps the palette from pushing out the paging of the mail list', async () => {
    const engine = await storeEngine();
    setOfflineHooks(hooksWith((_client, calls) => engine.answer(calls)));
    const client = await connected();
    await client.searchEmails('rechnung', undefined, undefined, 2);
    for (let i = 0; i < 100; i += 1) await client.searchEmails(`wort${i}`, undefined, undefined, 2, 0, { palette: true });
    requests = [];
    await client.searchEmails('rechnung', undefined, undefined, 2, 2);
    // With its cursor, the next page starts where the server left off, and nothing is walked again.
    const queries = requests.flatMap((calls) => calls.filter(([name]) => name === 'Email/query'));
    expect(queries.map(([, args]) => args.position)).toEqual([2]);
  });

  it('waits less for the store in the palette', async () => {
    setOfflineHooks(hooksWith(() => new Promise(() => {})));
    const client = await connected();
    const started = Date.now();
    const result = await client.searchEmails('rechnung', undefined, undefined, 50, 0, { palette: true });
    expect(result.emails.length).toBe(2);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('merges into advancedSearchEmails too, and leaves the server request as it was', async () => {
    const engine = await storeEngine();
    setOfflineHooks(hooksWith((_client, calls) => engine.answer(calls)));
    const client = await connected();
    const filter = { operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { text: 'rechnung' }] };
    const result = await client.advancedSearchEmails(filter);
    expect(result.emails.map((email) => email.id)).toEqual(['newer', 'both', 'only-local']);
    const query = requests[0][0];
    expect(query[0]).toBe('Email/query');
    expect(query[1]).toMatchObject({ filter, limit: 50, position: 0, calculateTotal: true, sort: [{ property: 'receivedAt', isAscending: false }] });
  });

  it('shows what the store found when the server fails', async () => {
    const engine = await storeEngine();
    setOfflineHooks(hooksWith((_client, calls) => engine.answer(calls)));
    const client = await connected();
    serverFails = true;
    const result = await client.searchEmails('rechnung');
    expect(result.emails.map((email) => email.id).sort()).toEqual(['both', 'only-local']);
  });

  it('shows what the server found when the store fails', async () => {
    setOfflineHooks(hooksWith(async () => { throw new Error('store broke'); }));
    const client = await connected();
    const result = await client.searchEmails('rechnung');
    expect(result.emails.map((email) => email.id)).toEqual(['newer', 'both']);
  });

  it('changes nothing when the store is off for the account', async () => {
    const searchLocal = vi.fn(async () => null);
    setOfflineHooks(hooksWith(searchLocal));
    const client = await connected();
    const result = await client.searchEmails('rechnung');
    expect(searchLocal).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ emails: expect.any(Array), total: 2, hasMore: false });
    expect(result.emails.map((email) => email.id)).toEqual(['newer', 'both']);
    expect(requests.length).toBe(1);
  });

  it('changes nothing without a store', async () => {
    setOfflineHooks(hooksWith(undefined));
    const client = await connected();
    const result = await client.searchEmails('rechnung', undefined, undefined, 50, 7);
    expect(requests[0][0][1].position).toBe(7);
    expect(result.total).toBe(2);
  });

  it('leaves filters without text to the server', async () => {
    const searchLocal = vi.fn(async () => null);
    setOfflineHooks(hooksWith(searchLocal));
    const client = await connected();
    await client.advancedSearchEmails({ inMailbox: 'inbox' });
    await client.advancedSearchEmails({});
    expect(searchLocal).not.toHaveBeenCalled();
  });

  it('does not ask twice when the device is answering anyway', async () => {
    const searchLocal = vi.fn(async () => null);
    const hooks = hooksWith(searchLocal, true);
    hooks.answer = async (_client, calls) => ({
      methodResponses: calls.map(([name, , id]) => (name === 'Email/query'
        ? [name, { ids: [], total: 0, position: 0 }, id]
        : [name, { list: [], notFound: [] }, id])),
    });
    setOfflineHooks(hooks);
    const client = await connected();
    await client.searchEmails('rechnung');
    expect(searchLocal).not.toHaveBeenCalled();
  });
});
