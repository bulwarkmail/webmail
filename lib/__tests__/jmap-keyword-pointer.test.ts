import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { keywordPointer, pointerToken, pointerTokenValue } from '../jmap/patch-pointer';

// A nested tag's id contains a slash (`work/clients`), so its keyword is
// `$label:work/clients`. PatchObject keys are JSON Pointers (RFC 8620 section
// 5.3), where an unescaped slash starts a new path segment - the server reads
// `keywords/$label:work/clients` as "the `clients` member of the `$label:work`
// keyword", which is not a boolean and is rejected or ignored. Nested tags can
// therefore only be written with the slash escaped as `~1`.

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'primary-account',
    username: 'user@example.com',
  });
  return client;
}

interface JMAPMethodCall {
  0: string;
  1: Record<string, unknown>;
  2: string;
}

/**
 * Answers Email/query with one id and then nothing - the walk ends on an empty
 * page - and Email/set with a plain success.
 */
function mockJmap() {
  const captured: JMAPMethodCall[] = [];
  let queried = false;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
    captured.push(...body.methodCalls);
    const methodResponses = body.methodCalls.map((call) => {
      if (call[0] !== 'Email/query') return ['Email/set', { updated: { m1: null } }, call[2]];
      const ids = queried ? [] : ['m1'];
      queried = true;
      return ['Email/query', { ids }, call[2]];
    });
    return new Response(JSON.stringify({ methodResponses }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { captured, fetchSpy };
}

function patchOf(captured: JMAPMethodCall[], emailId = 'm1'): Record<string, unknown> {
  const set = captured.find((call) => call[0] === 'Email/set');
  const update = set?.[1].update as Record<string, Record<string, unknown>> | undefined;
  return update?.[emailId] ?? {};
}

describe('pointerToken', () => {
  it('escapes a slash as ~1', () => {
    expect(pointerToken('work/clients')).toBe('work~1clients');
  });

  it('escapes a tilde as ~0, and does so before slashes', () => {
    expect(pointerToken('a~/b')).toBe('a~0~1b');
    expect(pointerToken('a~1b')).toBe('a~01b');
  });

  it('leaves a token with nothing to escape alone', () => {
    expect(keywordPointer('$label:red')).toBe('keywords/$label:red');
  });
});

describe('pointerTokenValue', () => {
  it('reads back what pointerToken wrote', () => {
    for (const value of ['work/clients', 'a~/b', 'a~1b', '$label:red', '~0/~1']) {
      expect(pointerTokenValue(pointerToken(value))).toBe(value);
    }
  });

  it('reads ~1 before ~0, so an escaped tilde stays literal', () => {
    expect(pointerTokenValue('~01')).toBe('~1');
  });
});

describe('keyword writes escape the JSON Pointer', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('setKeyword escapes a nested tag keyword', async () => {
    const { captured } = mockJmap();
    await createClient().setKeyword('m1', '$label:work/clients');
    expect(patchOf(captured)).toEqual({ 'keywords/$label:work~1clients': true });
  });

  it('removeKeyword escapes a nested tag keyword', async () => {
    const { captured } = mockJmap();
    await createClient().removeKeyword('m1', '$label:work/clients');
    expect(patchOf(captured)).toEqual({ 'keywords/$label:work~1clients': null });
  });

  it('migrateKeyword escapes both the old and the new keyword', async () => {
    const { captured } = mockJmap();
    await createClient().migrateKeyword('$label:work/clients', '$label:work/acme');
    expect(patchOf(captured)).toEqual({
      'keywords/$label:work~1clients': null,
      'keywords/$label:work~1acme': true,
    });
  });

  it('leaves a flat keyword unchanged', async () => {
    const { captured } = mockJmap();
    await createClient().setKeyword('m1', '$label:red');
    expect(patchOf(captured)).toEqual({ 'keywords/$label:red': true });
  });
});

describe('migrateKeyword reports a server that refused', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  /**
   * Answers queries from `pages` in order (an empty page ends the walk) and
   * every Email/set with `setResult`. A page given as an error tuple is
   * returned as the method response itself.
   */
  function mockRun(
    pages: (string[] | ['error', Record<string, unknown>])[],
    setResult: Record<string, unknown> | ['error', Record<string, unknown>] = { updated: {} },
  ) {
    let page = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
      const methodResponses = body.methodCalls.map((call) => {
        if (call[0] === 'Email/query') {
          const next = pages[Math.min(page, pages.length - 1)];
          page++;
          if (Array.isArray(next) && next[0] === 'error') {
            return ['error', next[1] as Record<string, unknown>, call[2]];
          }
          return ['Email/query', { ids: next as string[] }, call[2]];
        }
        if (Array.isArray(setResult) && setResult[0] === 'error') {
          return ['error', setResult[1] as Record<string, unknown>, call[2]];
        }
        return ['Email/set', setResult as Record<string, unknown>, call[2]];
      });
      return new Response(JSON.stringify({ methodResponses }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  it('throws when the query for tagged mail fails instead of reading it as none', async () => {
    mockRun([['error', { type: 'serverFail', description: 'boom' }]]);
    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).rejects.toThrow('boom');
  });

  it('throws when the update fails outright', async () => {
    mockRun([['m1'], []], ['error', { type: 'serverFail', description: 'no writes today' }]);
    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).rejects.toThrow(
      'no writes today',
    );
  });

  it('counts only the messages the server actually updated', async () => {
    mockRun([['m1', 'm2'], []], { updated: { m1: null }, notUpdated: { m2: { type: 'notFound' } } });
    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).resolves.toEqual({
      migrated: 1,
      refused: 0,
    });
  });

  it('reports a message refused for a reason other than being gone', async () => {
    mockRun([['m1', 'm2'], []], { updated: { m1: null }, notUpdated: { m2: { type: 'forbidden' } } });
    // Throwing would abandon m1, which this same call already migrated.
    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).resolves.toEqual({
      migrated: 1,
      refused: 1,
    });
  });

  it('keeps what it migrated when a later batch fails outright', async () => {
    // One message per Email/set, so the first write lands before the second
    // fails: throwing would strand m1 under the new keyword with the tag
    // definition still on the old one.
    const client = createClient();
    Object.assign(client, { capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInSet: 1 } } });
    let set = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
      const methodResponses = body.methodCalls.map((call) => {
        if (call[0] === 'Email/query') {
          return ['Email/query', { ids: set === 0 ? ['m1', 'm2'] : [], queryState: 's1' }, call[2]];
        }
        set++;
        return set === 1
          ? ['Email/set', { updated: { m1: null } }, call[2]]
          : ['error', { type: 'serverFail', description: 'gave up' }, call[2]];
      });
      return new Response(JSON.stringify({ methodResponses }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(client.migrateKeyword('$label:red', '$label:iso')).resolves.toEqual({
      migrated: 1,
      refused: 1,
    });
  });

  it('throws when nothing at all could be migrated', async () => {
    mockRun([['m1'], []], { notUpdated: { m1: { type: 'forbidden' } } });
    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).rejects.toThrow(
      'forbidden',
    );
  });

  it('restarts the walk when the query state changes under it', async () => {
    // Positions only line up within one queryState. The first page belongs to a
    // state that is gone by the next request; a walk that kept its position (and
    // the ids it had collected) would migrate mail the tag is no longer on and
    // miss the mail it is.
    const current = ['m1', 'm2'];
    let queries = 0;
    const touched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
      const methodResponses = body.methodCalls.map((call) => {
        if (call[0] === 'Email/query') {
          queries++;
          if (queries === 1) {
            return ['Email/query', { ids: ['stale1', 'stale2'], queryState: 's1' }, call[2]];
          }
          const position = call[1].position as number;
          const limit = call[1].limit as number;
          return ['Email/query', { ids: current.slice(position, position + limit), queryState: 's2' }, call[2]];
        }
        const update = call[1].update as Record<string, unknown>;
        touched.push(...Object.keys(update));
        return ['Email/set', { updated: Object.fromEntries(Object.keys(update).map((id) => [id, null])) }, call[2]];
      });
      return new Response(JSON.stringify({ methodResponses }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).resolves.toEqual({
      migrated: 2,
      refused: 0,
    });
    expect(touched).toEqual(['m1', 'm2']);
  });

  it('keeps migrating later batches after one message is refused', async () => {
    // A refusal is per message: the mail behind it in the queue is unaffected,
    // and skipping it would leave far more behind than the server refused.
    const client = createClient();
    Object.assign(client, { capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInSet: 1 } } });
    const touched: string[] = [];
    let queried = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
      const methodResponses = body.methodCalls.map((call) => {
        if (call[0] === 'Email/query') {
          const ids = queried ? [] : ['m1', 'm2'];
          queried = true;
          return ['Email/query', { ids, queryState: 's1' }, call[2]];
        }
        const id = Object.keys(call[1].update as Record<string, unknown>)[0];
        touched.push(id);
        return id === 'm1'
          ? ['Email/set', { notUpdated: { m1: { type: 'forbidden' } } }, call[2]]
          : ['Email/set', { updated: { [id]: null } }, call[2]];
      });
      return new Response(JSON.stringify({ methodResponses }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(client.migrateKeyword('$label:red', '$label:iso')).resolves.toEqual({
      migrated: 1,
      refused: 1,
    });
    expect(touched).toEqual(['m1', 'm2']);
  });

  it('gives up before writing anything when the mailbox will not hold still', async () => {
    // Each query reports a new state, so no page ever belongs with the last.
    // Mixing them would retag mail the tag has since been taken off.
    let queries = 0;
    const sets: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
      const methodResponses = body.methodCalls.map((call) => {
        if (call[0] === 'Email/query') {
          queries++;
          return ['Email/query', { ids: [`m${queries}`], queryState: `s${queries}` }, call[2]];
        }
        sets.push(call[2]);
        return ['Email/set', { updated: {} }, call[2]];
      });
      return new Response(JSON.stringify({ methodResponses }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).rejects.toThrow(
      /kept changing/,
    );
    expect(sets).toEqual([]);
  });

  it('ends the walk when a page repeats ids instead of paginating', async () => {
    // A server that answers every position with the same page would otherwise
    // be paged forever.
    mockRun([['m1']]);
    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).resolves.toEqual({
      migrated: 1,
      refused: 0,
    });
  });

  it('keeps paging when the server returns fewer ids than the limit asked for', async () => {
    // RFC 8620 section 5.5 lets a server clamp the limit. Treating a short page
    // as the last one would silently migrate only the first page.
    const pages = [['m1', 'm2'], ['m3'], []];
    let query = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as { methodCalls: JMAPMethodCall[] };
      const methodResponses = body.methodCalls.map((call) => {
        if (call[0] === 'Email/query') {
          const ids = pages[Math.min(query, pages.length - 1)];
          query++;
          return ['Email/query', { ids }, call[2]];
        }
        const update = call[1].update as Record<string, unknown>;
        const updated = Object.fromEntries(Object.keys(update).map((id) => [id, null]));
        return ['Email/set', { updated }, call[2]];
      });
      return new Response(JSON.stringify({ methodResponses }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(createClient().migrateKeyword('$label:red', '$label:iso')).resolves.toEqual({
      migrated: 3,
      refused: 0,
    });
    expect(query).toBe(3);
  });
});
