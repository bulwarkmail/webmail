// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { TransportError, type MethodCall, type StoreSession } from '../engine/transport';
import { mailArea } from '../mail';
import { headerValue, parseHeaderProperty } from '../mail/headers';
import { FAKE_SESSION, JMAP_ACCOUNT } from './helpers/fake-jmap';
import { FakeJmapMail } from './helpers/fake-jmap-mail';
import { openMemoryStore } from './helpers/node-adapter';

const EVERYTHING = { ...DEFAULT_SCOPE, days: null };

const FULL_SESSION: StoreSession = {
  ...FAKE_SESSION,
  accounts: {
    [JMAP_ACCOUNT]: {
      name: 'a@example.org',
      isPersonal: true,
      accountCapabilities: {
        'urn:ietf:params:jmap:mail': {},
        'urn:ietf:params:jmap:submission': {},
        'urn:ietf:params:jmap:quota': {},
      },
    },
  },
};

function engineFor(server: FakeJmapMail, scope = EVERYTHING, session = FULL_SESSION) {
  const db = openMemoryStore();
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session,
    transport: server,
    areas: [mailArea],
    scope,
    now: () => Date.UTC(2026, 10, 3),
    sleep: async () => {},
  });
  return { engine, db };
}

async function one(engine: AccountEngine, call: MethodCall) {
  const response = await engine.answer([call]);
  return response?.methodResponses[0];
}

const HEADERS = [
  { name: 'List-Id', value: ' Old list <old.example.org>' },
  { name: 'List-Id', value: ' =?UTF-8?B?VGVzdA==?= list\r\n <list.example.org>' },
  { name: 'From', value: ' "Doe, Jane" <jane@example.org>, Bob <bob@example.org>' },
  { name: 'To', value: ' Team: a@example.org, b@example.org;, c@example.org' },
  { name: 'Message-ID', value: ' <abc@example.org>' },
  { name: 'Date', value: ' Tue, 03 Nov 2026 10:00:00 +0100' },
  { name: 'List-Unsubscribe', value: ' <https://example.org/u>, <mailto:u@example.org>' },
];

describe('Email/get property forms', () => {
  async function seeded() {
    const server = new FakeJmapMail();
    server.addEmail({ id: 'm', headers: HEADERS, cc: [{ name: 'Carol', email: 'carol@example.org' }] });
    const { engine } = engineFor(server);
    await engine.requestSync();
    return engine;
  }

  it('answers every header form from the raw headers', async () => {
    const engine = await seeded();
    const [, result] = (await one(engine, ['Email/get', {
      ids: ['m'],
      properties: [
        'header:List-Id',
        'header:List-Id:asText',
        'header:list-id:asText:all',
        'header:List-Id:all',
        'header:From:asAddresses',
        'header:To:asGroupedAddresses',
        'header:Message-ID:asMessageIds',
        'header:Date:asDate',
        'header:List-Unsubscribe:asURLs',
        'header:Nope:asText',
        'header:Nope:all',
      ],
    }, 'g']))!;
    const got = result.list[0];
    expect(got['header:List-Id']).toBe(' =?UTF-8?B?VGVzdA==?= list\r\n <list.example.org>');
    expect(got['header:List-Id:asText']).toBe('Test list <list.example.org>');
    expect(got['header:list-id:asText:all']).toEqual(['Old list <old.example.org>', 'Test list <list.example.org>']);
    expect(got['header:List-Id:all']).toHaveLength(2);
    expect(got['header:From:asAddresses']).toEqual([{ name: 'Doe, Jane', email: 'jane@example.org' }, { name: 'Bob', email: 'bob@example.org' }]);
    expect(got['header:To:asGroupedAddresses']).toEqual([
      { name: 'Team', addresses: [{ name: null, email: 'a@example.org' }, { name: null, email: 'b@example.org' }] },
      { name: null, addresses: [{ name: null, email: 'c@example.org' }] },
    ]);
    expect(got['header:Message-ID:asMessageIds']).toEqual(['abc@example.org']);
    expect(got['header:Date:asDate']).toBe('2026-11-03T09:00:00.000Z');
    expect(got['header:List-Unsubscribe:asURLs']).toEqual(['https://example.org/u', 'mailto:u@example.org']);
    expect(got['header:Nope:asText']).toBeNull();
    expect(got['header:Nope:all']).toEqual([]);
  });

  it('prefers a form the list already stored, and has no header values for a message without a body', async () => {
    const server = new FakeJmapMail();
    server.addEmail({ id: 'm', headers: HEADERS, 'header:Authentication-Results:all': ['dkim=pass'] });
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    db.run('DELETE FROM email_body');
    const [, result] = (await one(engine, ['Email/get', {
      ids: ['m'],
      properties: ['id', 'header:Authentication-Results:all', 'header:List-Id:asText'],
    }, 'g']))!;
    expect(result.list).toEqual([{ id: 'm', 'header:Authentication-Results:all': ['dkim=pass'] }]);
  });

  it('cuts body parts to bodyProperties, in the structure too', async () => {
    const server = new FakeJmapMail();
    server.addEmail({
      id: 'm',
      attachments: [{ partId: '2', blobId: 'b', name: 'a.pdf', type: 'application/pdf', size: 3, language: ['de'] }],
      bodyStructure: { type: 'multipart/mixed', subParts: [{ partId: '1', type: 'text/plain', language: ['de'] }] },
    });
    const { engine } = engineFor(server, { ...EVERYTHING, attachments: false });
    await engine.requestSync();
    const [, result] = (await one(engine, ['Email/get', {
      ids: ['m'],
      properties: ['attachments', 'bodyStructure', 'textBody'],
      bodyProperties: ['partId', 'blobId', 'size', 'name', 'type'],
    }, 'g']))!;
    expect(result.list[0].attachments).toEqual([{ partId: '2', blobId: 'b', name: 'a.pdf', type: 'application/pdf', size: 3 }]);
    expect(result.list[0].bodyStructure).toEqual({ type: 'multipart/mixed', subParts: [{ partId: '1', type: 'text/plain' }] });
  });

  it('gives the whole text with no truncation mark, whatever maxBodyValueBytes says', async () => {
    const long = 'x'.repeat(5000);
    const server = new FakeJmapMail();
    server.addEmail({ id: 'm', bodyValues: { 1: { value: long, isTruncated: false, isEncodingProblem: false } } });
    const { engine } = engineFor(server);
    await engine.requestSync();
    const [, result] = (await one(engine, ['Email/get', { ids: ['m'], properties: ['bodyValues'], fetchAllBodyValues: true, maxBodyValueBytes: 100 }, 'g']))!;
    expect(result.list[0].bodyValues['1'].value).toBe(long);
    expect(result.list[0].bodyValues['1'].isTruncated).toBe(false);
  });

  it('returns only the body values asked for', async () => {
    const server = new FakeJmapMail();
    server.addEmail({
      id: 'm',
      textBody: [{ partId: 't', type: 'text/plain' }],
      htmlBody: [{ partId: 'h', type: 'text/html' }],
      bodyValues: { t: { value: 'text' }, h: { value: '<p>html</p>' } },
    });
    const { engine } = engineFor(server);
    await engine.requestSync();
    const values = async (flags: Record<string, unknown>) => (await one(engine, ['Email/get', { ids: ['m'], properties: ['bodyValues'], ...flags }, 'g']))![1].list[0].bodyValues;
    expect(Object.keys(await values({ fetchTextBodyValues: true }))).toEqual(['t']);
    expect(Object.keys(await values({ fetchHTMLBodyValues: true }))).toEqual(['h']);
    expect(Object.keys(await values({ fetchAllBodyValues: true })).sort()).toEqual(['h', 't']);
    expect(await values({})).toEqual({});
  });

  it('keeps refusing ids: null, because the server gives only the first 500 there', async () => {
    const engine = await seeded();
    const response = await engine.answer([['Email/get', { ids: null }, 'g'], ['Core/echo', {}, 'e']]);
    expect(response?.methodResponses[0]).toEqual(['error', expect.objectContaining({ type: 'requestTooLarge' }), 'g']);
  });
});

describe('header property parsing', () => {
  it('leaves out what is not a header form', () => {
    expect(parseHeaderProperty('subject')).toBeNull();
    expect(parseHeaderProperty('header:')).toBeNull();
    expect(parseHeaderProperty('header:X:asWhat')).toBeNull();
    expect(parseHeaderProperty('header:X-Label:asText')).toEqual({ name: 'X-Label', form: 'asText', all: false });
    expect(headerValue({ name: 'x', form: 'asRaw', all: false }, [{ name: 'X', value: ' 1' }, { name: 'x', value: ' 2' }])).toBe(' 2');
  });
});

describe('Email/query filters and sorts', () => {
  async function seeded() {
    const server = new FakeJmapMail({
      mailboxes: [
        { id: 'inbox', name: 'Inbox', role: 'inbox' },
        { id: 'trash', name: 'Trash', role: 'trash' },
        { id: 'work', name: 'Work' },
      ],
    });
    server.addEmail({
      id: 'a', subject: 'Rechnung', from: [{ name: 'Anna', email: 'anna@example.org' }], to: [{ email: 'x@example.org' }],
      cc: [{ name: 'Carol', email: 'carol@example.org' }], keywords: { $seen: true, '$label:work': true }, size: 500,
      receivedAt: '2026-10-01T00:00:00Z', hasAttachment: true, headers: [{ name: 'X-Tag', value: ' blue' }], bcc: [{ email: 'hidden@example.org' }],
    });
    server.addEmail({
      id: 'b', subject: 'Hello', from: [{ name: 'Bert', email: 'bert@example.org' }], to: [{ email: 'y@example.org' }],
      keywords: { $flagged: true }, size: 100, receivedAt: '2026-10-02T00:00:00Z', mailboxIds: { inbox: true, work: true },
    });
    server.addEmail({
      id: 'c', subject: 'Trash mail', from: [{ name: 'Cora', email: 'cora@example.org' }], to: [{ email: 'y@example.org' }],
      keywords: {}, size: 2000, receivedAt: '2026-10-03T00:00:00Z', mailboxIds: { trash: true },
    });
    const { engine } = engineFor(server);
    await engine.requestSync();
    return engine;
  }

  const ids = async (engine: AccountEngine, args: Record<string, unknown>) => (await one(engine, ['Email/query', args, 'q']))![1].ids;

  it('answers every shape the UI sends', async () => {
    const engine = await seeded();
    const newest = [{ property: 'receivedAt', isAscending: false }];
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ inMailbox: 'inbox' }, ['b', 'a']],
      [{ hasKeyword: '$seen' }, ['a']],
      [{ notKeyword: '$seen' }, ['c', 'b']],
      [{ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { notKeyword: '$seen' }] }, ['b']],
      [{ operator: 'NOT', conditions: [{ hasKeyword: '$label:work' }] }, ['c', 'b']],
      [{ operator: 'OR', conditions: [{ inMailbox: 'trash' }, { inMailbox: 'work' }] }, ['c', 'b']],
      [{ inMailboxOtherThan: ['trash'] }, ['b', 'a']],
      [{ text: 'rechnung' }, ['a']],
      [{ subject: 'hello' }, ['b']],
      [{ from: 'anna' }, ['a']],
      [{ to: 'y@example.org' }, ['c', 'b']],
      [{ cc: 'carol' }, ['a']],
      [{ bcc: 'hidden' }, ['a']],
      [{ header: ['X-Tag'] }, ['a']],
      [{ header: ['X-Tag', 'blue'] }, ['a']],
      [{ header: ['X-Tag', 'red'] }, []],
      [{ hasAttachment: true }, ['a']],
      [{ after: '2026-10-02T00:00:00Z' }, ['c', 'b']],
      [{ before: '2026-10-02T00:00:00Z' }, ['a']],
      [{ minSize: 500 }, ['c', 'a']],
      [{ maxSize: 500 }, ['b']],
      [{ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { operator: 'OR', conditions: [{ to: 'x@example.org' }, { cc: 'nobody' }] }] }, ['a']],
    ];
    for (const [filter, want] of cases) expect([filter, await ids(engine, { filter, sort: newest })]).toEqual([filter, want]);
    expect(await ids(engine, { sort: newest })).toEqual(['c', 'b', 'a']);
  });

  it('sorts by every level the list offers', async () => {
    const engine = await seeded();
    const sorted = (sort: unknown[]) => ids(engine, { sort });
    expect(await sorted([{ property: 'size', isAscending: true }])).toEqual(['b', 'a', 'c']);
    expect(await sorted([{ property: 'subject', isAscending: true }])).toEqual(['b', 'a', 'c']);
    expect(await sorted([{ property: 'from', isAscending: false }])).toEqual(['c', 'b', 'a']);
    expect(await sorted([{ property: 'sentAt', isAscending: true }])).toHaveLength(3);
    expect(await sorted([{ property: 'hasKeyword', keyword: '$flagged', isAscending: false }, { property: 'receivedAt', isAscending: false }])).toEqual(['b', 'c', 'a']);
  });

  it('gives a per-call error for a filter it can\'t answer, and no made-up state', async () => {
    const engine = await seeded();
    const response = await engine.answer([['Email/query', { filter: { allInThreadHaveKeyword: '$seen' } }, 'q'], ['Core/echo', {}, 'e']]);
    expect(response?.methodResponses[0][0]).toBe('error');
    expect(response?.methodResponses[0][1].type).toBe('unsupportedFilter');
    expect(await engine.answer([['Email/query', { filter: { allInThreadHaveKeyword: '$seen' } }, 'q']])).toBeNull();
  });

  it('says total only when asked, and pages by position', async () => {
    const engine = await seeded();
    const [, plain] = (await one(engine, ['Email/query', {}, 'q']))!;
    expect(plain).not.toHaveProperty('total');
    const [, page] = (await one(engine, ['Email/query', { position: 1, limit: 1, calculateTotal: true, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q']))!;
    expect(page).toMatchObject({ ids: ['b'], total: 3, position: 1 });
  });
});

describe('a store without its mail yet', () => {
  it('says so rather than answering an empty list, until the first sync has finished', async () => {
    const server = new FakeJmapMail();
    server.addEmail({ id: 'one' });
    const { engine } = engineFor(server);
    const inbox = Object.keys((server.emails.get('one')!.mailboxIds) as Record<string, boolean>)[0];
    const query = () => one(engine, ['Email/query', { filter: { inMailbox: inbox } }, 'q']);
    // No answer: the client reports it can't tell, and the list on screen stays.
    expect(await query()).toBeUndefined();
    await engine.requestSync();
    expect((await query())![1].ids).toEqual(['one']);
    // After a finished sync, an empty folder really is empty.
    server.destroyEmail('one');
    await engine.requestSync();
    expect((await query())![1].ids).toEqual([]);
  });

  it('tells a start whether there are folders to show', async () => {
    const server = new FakeJmapMail();
    const { engine } = engineFor(server);
    expect(await engine.areaCall('mail.hasFolders', {})).toBe(false);
    await engine.requestSync();
    expect(await engine.areaCall('mail.hasFolders', {})).toBe(true);
  });
});

describe('keyword case, as measured on both Stalwart versions', () => {
  it('keeps two keywords differing only in case, and sync doesn\'t stop on them', async () => {
    const server = new FakeJmapMail();
    server.addEmail({ id: 'both', keywords: { Tag: true, tag: true, $seen: true } });
    server.addEmail({ id: 'upper', keywords: { Tag: true, $SEEN: true, $seen: true } });
    server.addEmail({ id: 'none', keywords: {} });
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email')?.n).toBe(3);
    const has = async (keyword: string) => (await one(engine, ['Email/query', { filter: { hasKeyword: keyword }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q']))![1].ids;
    expect(await has('Tag')).toEqual(['upper', 'both']);
    expect(await has('tag')).toEqual(['both']);
    expect(await has('TAG')).toEqual([]);
    expect(await has('$SEEN')).toEqual(['upper', 'both']);
    const [, counts] = (await one(engine, ['Keyword/get', { ids: ['Tag', 'tag', '$SEEN'] }, 'k']))!;
    expect(counts.list).toEqual([{ id: 'Tag', total: 2, unread: 0 }, { id: 'tag', total: 1, unread: 0 }, { id: '$SEEN', total: 2, unread: 0 }]);
  });
});

describe('the rest of the mail methods', () => {
  it('answers Core/echo with what it was given', async () => {
    const { engine } = engineFor(new FakeJmapMail());
    expect(await one(engine, ['Core/echo', { ping: 'pong' }, 'e'])).toEqual(['Core/echo', { ping: 'pong' }, 'e']);
  });

  it('answers /changes with an error, so the client does a full fetch', async () => {
    const server = new FakeJmapMail();
    server.addEmail();
    const { engine } = engineFor(server);
    await engine.requestSync();
    const response = await engine.answer([
      ['Email/changes', { sinceState: 's1' }, 'e'],
      ['Mailbox/changes', { sinceState: 's1' }, 'm'],
      ['Core/echo', {}, 'x'],
    ]);
    expect(response?.methodResponses[0]).toEqual(['error', expect.objectContaining({ type: 'cannotCalculateChanges' }), 'e']);
    expect(response?.methodResponses[1]).toEqual(['error', expect.objectContaining({ type: 'cannotCalculateChanges' }), 'm']);
  });

  it('answers a search with its snippets in one request', async () => {
    const server = new FakeJmapMail();
    server.addEmail({ subject: 'Findme' });
    const { engine } = engineFor(server);
    await engine.requestSync();
    const response = await engine.answer([
      ['Email/query', { filter: { text: 'findme' } }, '0'],
      ['SearchSnippet/get', { filter: { text: 'findme' }, '#emailIds': { resultOf: '0', name: 'Email/query', path: '/ids' } }, 'snippets'],
    ]);
    expect(response?.methodResponses[0][1].ids).toHaveLength(1);
    expect(response?.methodResponses[1][0]).toBe('SearchSnippet/get');
  });

  it('counts keywords for Keyword/get', async () => {
    const server = new FakeJmapMail();
    server.addEmail({ keywords: { '$label:a': true, $seen: true } });
    server.addEmail({ keywords: { '$label:a': true } });
    const { engine } = engineFor(server);
    await engine.requestSync();
    const [, wanted] = (await one(engine, ['Keyword/get', { ids: ['$label:a', '$label:none'] }, 'k']))!;
    expect(wanted.list).toEqual([{ id: '$label:a', total: 2, unread: 1 }, { id: '$label:none', total: 0, unread: 0 }]);
    const [, all] = (await one(engine, ['Keyword/get', {}, 'k']))!;
    expect(all.totalEmails).toBe(2);
    expect(all.list.map((k: { id: string }) => k.id).sort()).toEqual(['$label:a', '$seen']);
  });

  it('keeps identities through a sync and answers them, with the real state', async () => {
    const server = new FakeJmapMail();
    server.identities.set('i1', { id: 'i1', email: 'a@example.org', name: 'A' });
    const { engine } = engineFor(server);
    expect((await one(engine, ['Identity/get', {}, 'i']))).toBeUndefined();
    await engine.requestSync();
    const [, result] = (await one(engine, ['Identity/get', {}, 'i']))!;
    expect(result.list).toEqual([{ id: 'i1', email: 'a@example.org', name: 'A' }]);
    expect(result.state).toBe('s0');

    server.identities.set('i2', { id: 'i2', email: 'b@example.org', name: 'B' });
    server.identityState = 1;
    await engine.requestSync();
    expect((await one(engine, ['Identity/get', { ids: ['i2'] }, 'i']))![1].list).toEqual([{ id: 'i2', email: 'b@example.org', name: 'B' }]);
  });

  it('keeps the last quota', async () => {
    const server = new FakeJmapMail();
    server.quotas.push({ id: 'q', used: 10, hardLimit: 100 });
    const { engine } = engineFor(server);
    await engine.requestSync();
    server.offline = true;
    expect((await one(engine, ['Quota/get', {}, 'q']))![1].list).toEqual([{ id: 'q', used: 10, hardLimit: 100 }]);
  });

  it('keeps going when one account has no submission capability', async () => {
    const server = new FakeJmapMail();
    server.addEmail();
    const { engine, db } = engineFor(server, EVERYTHING, FAKE_SESSION);
    await engine.requestSync();
    expect(db.get('SELECT 1 AS x FROM email')).toBeTruthy();
    expect(server.calls.some(([name]) => name === 'Identity/get')).toBe(false);
  });

  it('removes a folder deleted on the server, and answers what is left', async () => {
    const server = new FakeJmapMail({ mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }, { id: 'old', name: 'Old' }] });
    const { engine } = engineFor(server);
    await engine.requestSync();
    server.mailboxes.delete('old');
    server.coll.Mailbox.push('destroyed', 'old');
    await engine.requestSync();
    const [, result] = (await one(engine, ['Mailbox/get', {}, 'm']))!;
    expect(result.list.map((box: { id: string }) => box.id)).toEqual(['inbox']);
    const [, queried] = (await one(engine, ['Mailbox/query', { filter: { role: 'inbox' } }, 'q']))!;
    expect(queried).toMatchObject({ ids: ['inbox'], queryState: server.coll.Mailbox.state() });
  });
});

describe('attachments', () => {
  class Files extends FakeJmapMail {
    downloads: string[] = [];
    missing = new Set<string>();
    override async download(_jmap?: string, blobId?: string): Promise<Uint8Array> {
      this.downloads.push(String(blobId));
      if (this.offline) throw new TransportError('network', 'Failed to fetch');
      if (this.missing.has(String(blobId))) throw new TransportError('http', 'Gone', 404);
      return new Uint8Array([1, 2, 3]);
    }
  }

  const withFile = (server: Files, id: string, blobId: string, size = 3) => server.addEmail({
    id,
    attachments: [{ partId: '2', blobId, name: `${blobId}.pdf`, type: 'application/pdf', size }],
  });

  it('keeps the files of kept messages within the chosen size, and deletes them with the message', async () => {
    const server = new Files();
    withFile(server, 'small', 'b-small');
    withFile(server, 'big', 'b-big', 10_000);
    const { engine, db } = engineFor(server, { ...EVERYTHING, maxAttachmentBytes: 1000 });
    await engine.requestSync();
    expect(server.downloads).toEqual(['b-small']);
    const stored = await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-small' }) as { type: string; data: Uint8Array };
    expect(stored.type).toBe('application/pdf');
    expect([...stored.data]).toEqual([1, 2, 3]);

    server.destroyEmail('small');
    await engine.requestSync();
    expect(await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-small' })).toBeNull();
    expect(db.get('SELECT 1 AS x FROM email_part WHERE blob_id = ?', ['b-small'])).toBeUndefined();
  });

  it('keeps a shared file until the last message using it goes', async () => {
    const server = new Files();
    withFile(server, 'one', 'b-same');
    withFile(server, 'two', 'b-same');
    const { engine } = engineFor(server);
    await engine.requestSync();
    server.destroyEmail('one');
    await engine.requestSync();
    expect(await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-same' })).not.toBeNull();
    server.destroyEmail('two');
    await engine.requestSync();
    expect(await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-same' })).toBeNull();
  });

  it('keeps none when the user chose so, stops at the total, and doesn\'t ask again for a file the server refused', async () => {
    const off = new Files();
    withFile(off, 'm', 'b-1');
    await engineFor(off, { ...EVERYTHING, attachments: false }).engine.requestSync();
    expect(off.downloads).toEqual([]);

    const capped = new Files();
    withFile(capped, 'old', 'b-old', 3);
    withFile(capped, 'new', 'b-new', 3);
    await engineFor(capped, { ...EVERYTHING, maxTotalBytes: 4 }).engine.requestSync();
    expect(capped.downloads).toEqual(['b-new']);

    const refused = new Files();
    refused.missing.add('b-gone');
    withFile(refused, 'm', 'b-gone');
    const { engine } = engineFor(refused);
    await engine.requestSync();
    await engine.requestSync();
    expect(refused.downloads).toEqual(['b-gone']);
  });

  it.each([500, 503, 429, 401])('tries a file again after a %i, which says nothing about the file', async (status) => {
    class Failing extends Files {
      fails = true;
      override async download(jmap?: string, blobId?: string): Promise<Uint8Array> {
        if (this.fails) throw new TransportError('http', 'Nope', status);
        return super.download(jmap, blobId);
      }
    }
    const server = new Failing();
    server.addEmail({ id: 'm', attachments: [{ blobId: 'b', size: 10, type: 'image/png' }] });
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    expect(db.get<{ refused: number }>('SELECT refused FROM email_part')?.refused).toBe(0);
    server.fails = false;
    server.addEmail({ id: 'n' });
    await engine.requestSync();
    expect(await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b' })).not.toBeNull();
  });

  it.each([403, 404, 410])('gives up on a file after a %i', async (status) => {
    class Refusing extends Files {
      override async download(): Promise<Uint8Array> {
        throw new TransportError('http', 'Nope', status);
      }
    }
    const server = new Refusing();
    server.addEmail({ id: 'm', attachments: [{ blobId: 'b', size: 10, type: 'image/png' }] });
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    expect(db.get<{ refused: number }>('SELECT refused FROM email_part')?.refused).toBe(1);
  });

  it('files a blob the user opened only as far as the chosen scope allows', async () => {
    const server = new Files();
    server.addEmail({ id: 'm', attachments: [{ blobId: 'b-kept', size: 10, type: 'image/png' }] });
    const data = new Uint8Array(10);
    const record = { jmap: JMAP_ACCOUNT, blobId: 'b-kept', type: 'image/png', data };

    const none = engineFor(server, { ...EVERYTHING, attachments: false });
    await none.engine.requestSync();
    expect(await none.engine.areaCall('mail.recordBlob', record)).toBe(false);
    expect(await none.engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-kept' })).toBeNull();

    const small = engineFor(server, { ...EVERYTHING, attachments: true, maxAttachmentBytes: 9 });
    await small.engine.requestSync();
    expect(await small.engine.areaCall('mail.recordBlob', record)).toBe(false);

    const fits = engineFor(server, { ...EVERYTHING, attachments: true, maxAttachmentBytes: 10 });
    await fits.engine.requestSync();
    expect(await fits.engine.areaCall('mail.recordBlob', record)).toBe(true);
  });

  it('files a blob the user opened only under a kept message: never a stray file', async () => {
    const server = new Files();
    server.addEmail({ id: 'm', attachments: [{ blobId: 'b-kept', size: 99_999_999, type: 'image/png' }] });
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(await engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'export-of-a-message', type: null, data: new Uint8Array([1]) })).toBe(false);
    expect(await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'export-of-a-message' })).toBeNull();
    expect(await engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-kept', type: 'image/png', data: new Uint8Array([7]) })).toBe(true);
    expect(await engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-kept' })).toMatchObject({ type: 'image/png' });
  });
});

describe('what the user opened online', () => {
  it('keeps a message from outside the window with its text, and leaves kept ones alone', async () => {
    const server = new FakeJmapMail();
    server.addEmail({ id: 'kept', subject: 'Kept' });
    const { engine } = engineFor(server);
    await engine.requestSync();
    const opened = {
      id: 'old', threadId: 'told', mailboxIds: { inbox: true }, keywords: {}, receivedAt: '2019-01-01T00:00:00Z', subject: 'Old',
      textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [], bodyValues: { 1: { value: 'Old text' } }, headers: [{ name: 'X', value: ' y' }],
    };
    await engine.areaCall('mail.recordOpened', {
      jmap: JMAP_ACCOUNT,
      emails: [
        opened,
        { id: 'kept', subject: 'Changed?', bodyValues: { 1: { value: 'other' } }, mailboxIds: {}, receivedAt: '2019-01-01T00:00:00Z' },
        { id: 'cut', mailboxIds: { inbox: true }, receivedAt: '2019-01-01T00:00:00Z', bodyValues: { 1: { value: 'par', isTruncated: true } } },
        { id: 'nobody', mailboxIds: { inbox: true }, receivedAt: '2019-01-01T00:00:00Z' },
      ],
    });
    const [, result] = (await one(engine, ['Email/get', { ids: ['old', 'kept', 'cut', 'nobody'], properties: ['subject', 'bodyValues', 'header:X:asText'], fetchAllBodyValues: true }, 'g']))!;
    expect(result.notFound).toEqual(['cut', 'nobody']);
    expect(result.list[0]).toMatchObject({ id: 'old', subject: 'Old', 'header:X:asText': 'y' });
    expect(result.list[0].bodyValues['1'].value).toBe('Old text');
    expect(result.list[1].subject).toBe('Kept');
  });
});

describe('usage and session', () => {
  it('reports the bytes of the file and the kept session', async () => {
    const { engine } = engineFor(new FakeJmapMail());
    expect((await engine.areaCall('mail.usage', {}) as { bytes: number }).bytes).toBeGreaterThan(0);
    expect(await engine.areaCall('mail.session', {})).toEqual(FULL_SESSION);
  });
});
