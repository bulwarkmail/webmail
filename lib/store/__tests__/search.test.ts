// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildJMAPFilter, DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { parseSearchSnippet, snippetFilterFor } from '@/lib/search-snippet';
import { DEFAULT_SCOPE } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { mailArea } from '../mail';
import { bodyText, deleteEmail } from '../mail/records';
import { FAKE_SESSION, FakeJmap } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

type Email = Parameters<FakeJmap['addEmail']>[0];

function withBody(value: string): Email {
  return { bodyValues: { 1: { value, isTruncated: false, isEncodingProblem: false } } };
}

async function storeWith(emails: Email[], db = openMemoryStore()) {
  const server = new FakeJmap();
  for (const email of emails) server.addEmail(email);
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session: FAKE_SESSION,
    transport: server,
    areas: [mailArea],
    scope: { ...DEFAULT_SCOPE, days: null },
    now: () => Date.UTC(2026, 10, 3),
    sleep: async () => {},
  });
  await engine.requestSync();
  const query = async (filter: Record<string, unknown>) => {
    // A second call, because a request with no call answered comes back as null.
    const answer = await engine.answer([
      ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: true }] }, 'q'],
      ['Mailbox/get', { ids: [] }, 'm'],
    ]);
    const [name, result] = answer?.methodResponses[0] ?? ['error', { type: 'no answer' }];
    if (name === 'error') throw new Error(`per-call error: ${result.type}`);
    return result.ids as string[];
  };
  const snippets = async (filter: Record<string, unknown> | null, emailIds: string[]) => {
    const answer = await engine.answer([['SearchSnippet/get', { filter, emailIds }, 's']]);
    return answer?.methodResponses[0][1] as {
      list: Array<{ emailId: string; subject: string | null; preview: string | null }>;
      notFound: string[];
    };
  };
  return { engine, query, snippets, db };
}

/** A store that records the statements it runs. */
function recordingStore() {
  const db = openMemoryStore();
  const statements: string[] = [];
  const run = db.run.bind(db);
  db.run = (sql, params) => {
    statements.push(sql);
    return run(sql, params);
  };
  return { db, statements };
}

const alice = [{ name: 'Alice Adler', email: 'alice@example.org' }];
const bob = [{ name: 'Bob Berg', email: 'bob@example.org' }];
const carol = [{ name: 'Carol Conrad', email: 'carol@example.org' }];
const dave = [{ name: 'Dave Dorn', email: 'dave@example.org' }];

describe('matching', () => {
  it('finds a word inside a German compound, in the subject and in the body', async () => {
    const { query } = await storeWith([
      { id: 'subject', subject: 'Zahlungserinnerungsrechnung Oktober' },
      { id: 'body', subject: 'Hallo', ...withBody('Anbei die Stromrechnung.') },
      { id: 'other', subject: 'Einladung', ...withBody('Bis morgen') },
    ]);
    expect(await query({ text: 'rechnung' })).toEqual(['subject', 'body']);
    expect(await query({ subject: 'rechnung' })).toEqual(['subject']);
    expect(await query({ body: 'rechnung' })).toEqual(['body']);
  });

  it('reads word* as the start of a word, not anywhere in it', async () => {
    const { query } = await storeWith([
      { id: 'start', subject: 'Rechnungsbetrag offen' },
      { id: 'inside', subject: 'Stromrechnung offen' },
    ]);
    expect(await query({ text: 'rechn*' })).toEqual(['start']);
    expect(await query({ text: 'rechn' })).toEqual(['start', 'inside']);
  });

  it('reads a quoted phrase as exact words in order', async () => {
    const { query } = await storeWith([
      { id: 'phrase', subject: 'The annual report is here' },
      { id: 'apart', subject: 'The report for annual leave' },
      { id: 'compound', subject: 'Stromrechnung' },
      { id: 'word', subject: 'Eine Rechnung' },
    ]);
    expect(await query({ text: '"annual report"' })).toEqual(['phrase']);
    expect(await query({ text: '"rechnung"' })).toEqual(['word']);
  });

  it('matches one and two characters as whole words only, unless a star asks for more', async () => {
    const { query } = await storeWith([
      { id: 'zu', subject: 'Bitte zu Hause' },
      { id: 'zum', subject: 'Bitte zum Arzt' },
      { id: 'a', subject: 'Plan a today' },
      { id: 'anna', subject: 'Anna kommt' },
    ]);
    expect(await query({ subject: 'zu' })).toEqual(['zu']);
    expect(await query({ subject: 'zu*' })).toEqual(['zu', 'zum']);
    expect(await query({ subject: 'a' })).toEqual(['a']);
    // One letter is too expensive as a prefix, so it stays the word.
    expect(await query({ subject: 'a*' })).toEqual(['a']);
  });

  it('keeps To, Cc and Bcc apart, and searches all of them for text', async () => {
    const { query } = await storeWith([
      { id: 'one', from: alice, to: bob, cc: carol, bcc: dave },
    ]);
    expect(await query({ from: 'alice' })).toEqual(['one']);
    expect(await query({ to: 'bob' })).toEqual(['one']);
    expect(await query({ to: 'carol' })).toEqual([]);
    expect(await query({ to: 'dave' })).toEqual([]);
    expect(await query({ cc: 'carol' })).toEqual(['one']);
    expect(await query({ cc: 'bob' })).toEqual([]);
    expect(await query({ bcc: 'dave' })).toEqual(['one']);
    expect(await query({ bcc: 'carol' })).toEqual([]);
    for (const name of ['alice', 'bob', 'carol', 'dave']) expect(await query({ text: name })).toEqual(['one']);
  });

  it('answers the recipient search the client sends', async () => {
    const { query } = await storeWith([
      { id: 'to', to: bob },
      { id: 'cc', to: alice, cc: bob },
      { id: 'none', to: alice },
    ]);
    expect(await query({ operator: 'OR', conditions: [{ to: 'bob@example.org' }, { cc: 'bob@example.org' }] })).toEqual(['to', 'cc']);
  });

  it('answers every search shape buildJMAPFilter produces', async () => {
    const { query } = await storeWith([
      {
        id: 'hit',
        subject: 'Budget 2024 annual report',
        from: alice,
        to: bob,
        ...withBody('Die Stromrechnung liegt bei'),
      },
      { id: 'miss', subject: 'Budget 2024', from: alice, to: bob, ...withBody('Nichts') },
    ]);
    const filter = buildJMAPFilter('"annual report" budg* 2024', {
      ...DEFAULT_SEARCH_FILTERS,
      from: 'alice',
      to: 'bob',
      subject: 'annual',
      body: 'rechnung',
    }, 'inbox');
    expect(await query(filter)).toEqual(['hit']);
  });

  it('ignores diacritics both ways', async () => {
    const { query } = await storeWith([
      { id: 'umlaut', subject: 'Frau Müller' },
      { id: 'plain', subject: 'Herr Muller' },
      { id: 'accent', subject: 'Café am Markt' },
    ]);
    expect(await query({ text: 'Müller' })).toEqual(['umlaut', 'plain']);
    expect(await query({ text: 'muller' })).toEqual(['umlaut', 'plain']);
    expect(await query({ text: 'cafe' })).toEqual(['accent']);
    expect(await query({ text: 'Café' })).toEqual(['accent']);
    expect(await query({ text: 'mül*' })).toEqual(['umlaut', 'plain']);
  });

  it('finds the spelled-out German spelling both ways, without false friends', async () => {
    const { query } = await storeWith([
      { id: 'umlaut', subject: 'Frau Müller' },
      { id: 'written', subject: 'Herr Mueller' },
      { id: 'sharp', subject: 'Hauptstraße 1' },
      { id: 'double', subject: 'Hauptstrasse 2' },
      { id: 'care', subject: 'Die Betreuung beginnt' },
      { id: 'loyal', subject: 'Treue' },
    ]);
    expect(await query({ text: 'Mueller' })).toEqual(['umlaut', 'written']);
    expect(await query({ text: 'Müller' })).toEqual(['umlaut', 'written']);
    expect(await query({ text: 'Hauptstraße' })).toEqual(['sharp', 'double']);
    expect(await query({ text: 'Hauptstrasse' })).toEqual(['sharp', 'double']);
    // "treu" is inside "Betreuung": the plain spelling is a whole word only.
    expect(await query({ text: 'Treue' })).toEqual(['loyal']);
  });

  it('finds an umlaut an HTML mail wrote as an entity', async () => {
    const { query } = await storeWith([{
      id: 'html',
      subject: 'Hallo',
      textBody: [],
      htmlBody: [{ partId: '1', type: 'text/html' }],
      ...withBody('<head><title>Vorlage</title></head><p>Gr&uuml;&szlig;e von Frau M&#252;ller &amp;lt;Chefin&amp;gt;</p>'),
    }]);
    expect(await query({ body: 'Müller' })).toEqual(['html']);
    expect(await query({ body: 'grüße' })).toEqual(['html']);
    expect(await query({ body: 'Vorlage' })).toEqual([]);
    // Decoded once: the encoded text stays text.
    expect(await query({ body: '"&lt;Chefin&gt;"' })).toEqual(['html']);
  });

  it('answers a very common word', async () => {
    const emails: Email[] = [];
    for (let i = 0; i < 300; i += 1) emails.push({ subject: 'die Rechnung für die Firma' });
    const { query } = await storeWith(emails);
    expect((await query({ text: 'die' })).length).toBe(300);
  });
});

describe('the split indexes', () => {
  it('writes each index once for a message, with no delete when its body arrives', async () => {
    const { db, statements } = recordingStore();
    await storeWith([{ id: 'one', subject: 'Hallo', ...withBody('Inhalt') }], db);
    const fts = statements.filter((sql) => sql.includes('email_fts'));
    expect(fts.filter((sql) => sql.startsWith('DELETE'))).toEqual([]);
    for (const table of ['email_fts_word', 'email_fts_tri', 'email_fts_body_word', 'email_fts_body_tri']) {
      expect(fts.filter((sql) => sql.startsWith(`INSERT INTO ${table} `)).length, table).toBe(1);
    }
  });

  it('touches the head row again only for a message with Bcc', async () => {
    const { db, statements } = recordingStore();
    const { query } = await storeWith([{ id: 'one', subject: 'Hallo', bcc: dave }], db);
    const fts = statements.filter((sql) => sql.includes('email_fts'));
    expect(fts.filter((sql) => sql.startsWith('DELETE FROM email_fts_word')).length).toBe(1);
    expect(fts.filter((sql) => sql.startsWith('DELETE FROM email_fts_body'))).toEqual([]);
    // Nothing of the head was lost in writing it again.
    expect(await query({ subject: 'hallo' })).toEqual(['one']);
    expect(await query({ bcc: 'dave' })).toEqual(['one']);
  });

  it('finds head fields only in the head and body text only in the body', async () => {
    const { query } = await storeWith([
      { id: 'in-subject', subject: 'Stromrechnung', ...withBody('nichts') },
      { id: 'in-body', subject: 'Hallo', ...withBody('Die Stromrechnung') },
      { id: 'from-word', subject: 'Hallo', from: [{ name: 'Stromrechnung', email: 'x@example.org' }], ...withBody('nichts') },
    ]);
    expect(await query({ text: 'rechnung' })).toEqual(['in-subject', 'in-body', 'from-word']);
    expect(await query({ text: 'stromrechnung' })).toEqual(['in-subject', 'in-body', 'from-word']);
    expect(await query({ subject: 'rechnung' })).toEqual(['in-subject']);
    expect(await query({ body: 'rechnung' })).toEqual(['in-body']);
    expect(await query({ from: 'rechnung' })).toEqual(['from-word']);
  });

  it('keeps each word of a search free to match in the head or the body', async () => {
    const { query } = await storeWith([{ id: 'one', subject: 'Rechnung', ...withBody('Oktober') }, { id: 'two', subject: 'Rechnung' }]);
    expect(await query({ text: 'rechnung oktober' })).toEqual(['one']);
  });

  it('caps the trigrams of a body at 32 KB and leaves its words to 200 KB', async () => {
    const filler = 'fuellwort '.repeat(4000);
    const { query } = await storeWith([
      { id: 'early', subject: 'x', ...withBody('Stromrechnung am Anfang') },
      { id: 'late', subject: 'x', ...withBody(`${filler} Gasrechnung am Ende`) },
      { id: 'past', subject: 'x', ...withBody(`${filler.repeat(6)} Wasserrechnung`) },
    ]);
    expect(await query({ body: 'rechnung' })).toEqual(['early']);
    // Past the trigram cap the whole word and its start are still found.
    expect(await query({ body: 'gasrechnung' })).toEqual(['late']);
    expect(await query({ body: 'gasrech*' })).toEqual(['late']);
    // Past the word cap too: not indexed at all.
    expect(await query({ body: 'wasserrechnung' })).toEqual([]);
  });

  it('removes a message from all four indexes', async () => {
    const { db, query } = await storeWith([{ id: 'one', subject: 'Hallo', ...withBody('Inhalt') }]);
    const jmap = String(db.get<{ jmap: string }>('SELECT jmap FROM email')?.jmap);
    deleteEmail(db, jmap, 'one');
    for (const table of ['email_fts_word', 'email_fts_tri']) expect(db.all(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`, ['"hallo"'])).toEqual([]);
    for (const table of ['email_fts_body_word', 'email_fts_body_tri']) expect(db.all(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`, ['"inhalt"'])).toEqual([]);
    expect(await query({ text: 'inhalt' })).toEqual([]);
  });

  it('sets the options for bulk writes', async () => {
    const { db } = await storeWith([]);
    const option = (table: string, key: string) => Number(db.get<{ v: number }>(`SELECT v FROM ${table}_config WHERE k = ?`, [key])?.v);
    expect(option('email_fts_body_word', 'hashsize')).toBe(8 * 1024 * 1024);
    expect(option('email_fts_body_tri', 'hashsize')).toBe(16 * 1024 * 1024);
    for (const table of ['email_fts_word', 'email_fts_tri', 'email_fts_body_word', 'email_fts_body_tri']) {
      expect(option(table, 'automerge'), table).toBe(8);
    }
  });
});

describe('bodyText', () => {
  const html = (value: string) => ({
    textBody: [],
    htmlBody: [{ partId: '1', type: 'text/html' }],
    bodyValues: { 1: { value } },
  });
  const MEGABYTE = 1_000_000;
  const HOSTILE: Record<string, string> = {
    'opening brackets': '<'.repeat(MEGABYTE),
    'comment openers': '<!--'.repeat(MEGABYTE / 4),
    'style openers': '<style'.repeat(MEGABYTE / 6),
    'style tags': '<style>'.repeat(MEGABYTE / 7),
    'head and script openers': '<head><script>'.repeat(MEGABYTE / 14),
    'one long tag': `<${'a'.repeat(MEGABYTE)}`,
    'ampersands': '&'.repeat(MEGABYTE),
    'an endless entity': `&${'a'.repeat(MEGABYTE)}`,
    'many entities': '&a'.repeat(MEGABYTE / 2),
    'spaces': ' '.repeat(MEGABYTE),
    'closed blocks': '<style>x</style>'.repeat(MEGABYTE / 16),
  };

  for (const [name, value] of Object.entries(HOSTILE)) {
    it(`gets through a 1 MB body of ${name} fast`, () => {
      const started = Date.now();
      bodyText(html(value));
      // Generous, to not be flaky. The quadratic version took 40 s on a sixth of this.
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }

  it('caps what it reads', () => {
    expect(bodyText(html(`<p>${'x'.repeat(2 * MEGABYTE)}</p>`)).length).toBeLessThanOrEqual(MEGABYTE);
    expect(bodyText({
      textBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { 1: { value: 'y'.repeat(2 * MEGABYTE) } },
    }).length).toBe(MEGABYTE);
  });

  it('still takes out tags, comments and blocks, whatever their case', () => {
    expect(bodyText(html(
      '<!-- a --><HEAD><title>b</title></HEAD><STYLE>c</style><script type="x">d</SCRIPT><header>kept</header><p>text</p><!-- e -->',
    )).trim()).toBe('kept text');
  });

  it('leaves the text of a block that never closes', () => {
    expect(bodyText(html('before <style>.a{} after')).trim()).toBe('before .a{} after');
    expect(bodyText(html('before <!-- after')).trim()).toBe('before <!-- after');
    // One kind left open doesn't stop the others being taken out.
    expect(bodyText(html('<style>a <script>b</script> c')).trim()).toBe('a c');
  });

  it('does not take a property of Object for an entity', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(bodyText(html(`a &${name}; b`))).toBe(`a &${name}; b`);
    }
    expect(bodyText(html('Gr&uuml;&szlig;e &#252; &#xFC;'))).toBe('Grüße ü ü');
  });
});

describe('hostile input', () => {
  const HOSTILE = [
    '"', '""', '"""', '" "', '"unterminated', 'odd " quote', '*', '**', '*foo', 'foo*bar', 'a*b*c*',
    '-', '--', '-foo', 'foo-', 'foo - bar', ':', 'subject:', 'subject:foo', 'nope:foo', 'from_addr : x',
    '(', ')', '()', '(foo', 'foo)', '((((', '))))', '(foo OR bar)',
    'AND', 'OR', 'NOT', 'NEAR', 'NEAR(a b)', 'NEAR(a b, 2)', 'a AND', 'OR b', 'NOT c', 'a OR OR b',
    '^', '^foo', '+', 'foo + bar', '{', '{subject body}: foo', '}', '[', ']', '\\', '\\"', "'", "'foo'", '%', '_', ';',
    "'; DROP TABLE email; --", 'foo\0bar', '\0', '\x01\x02', '\n', '\t', '\ud83d', '\udc00', '🎉', '🎉🎉🎉', '<mark>',
    'x'.repeat(100_000), '"'.repeat(5001), '('.repeat(5001), 'a '.repeat(5000), '"a" '.repeat(2000), 'a* '.repeat(2000),
  ];

  it('never throws, for any field and any input', async () => {
    const { query } = await storeWith([{ subject: 'foo bar' }]);
    for (const field of ['text', 'subject', 'from', 'to', 'cc', 'bcc', 'body']) {
      for (const input of HOSTILE) {
        await expect(query({ [field]: input }), `${field}: ${input.slice(0, 30)}`).resolves.toBeInstanceOf(Array);
      }
    }
  });

  it('reads the punctuation as text around the words', async () => {
    const { query } = await storeWith([
      { id: 'hit', subject: 'foo bar' },
      { id: 'miss', subject: 'other words' },
    ]);
    for (const input of ['foo - bar', '(foo)', '(foo bar)', 'foo: bar:', '"foo" -', '-foo', 'foo*', 'foo-bar']) {
      expect(await query({ text: input }), input).toEqual(['hit']);
    }
  });

  it('finds nothing, rather than everything, when no term is left', async () => {
    const { query } = await storeWith([{ subject: 'foo bar' }]);
    for (const input of ['', ' ', '*', '-', '"', '""', '()', '🎉']) {
      expect(await query({ text: input }), input).toEqual([]);
    }
  });

  it('caps what one value and one filter can ask, widening rather than failing', async () => {
    const { query } = await storeWith([{ id: 'hit', subject: 'foo' }]);
    // The terms past the limit are ignored.
    expect(await query({ text: `${'foo '.repeat(16)} nothere` })).toEqual(['hit']);
    const many = Array.from({ length: 1000 }, (_, i) => ({ text: i < 32 ? 'foo' : 'nothere' }));
    expect(await query({ operator: 'AND', conditions: many })).toEqual(['hit']);
  });

  it('refuses too many terms where dropping one would change the meaning', async () => {
    const { query } = await storeWith([{ id: 'hit', subject: 'foo' }]);
    const many = Array.from({ length: 33 }, () => ({ text: 'foo' }));
    await expect(query({ operator: 'OR', conditions: many })).rejects.toThrow('unsupportedFilter');
    await expect(query({ operator: 'NOT', conditions: many })).rejects.toThrow('unsupportedFilter');
    await expect(query({ operator: 'OR', conditions: many.slice(0, 32) })).resolves.toEqual(['hit']);
  });
});

describe('SearchSnippet/get', () => {
  it('marks the terms in the subject and the body, as the server would', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'Die Rechnung', ...withBody('Hier ist die Rechnung von heute.') }]);
    const { list, notFound } = await snippets({ text: 'rechnung' }, ['one', 'gone']);
    expect(list).toEqual([{
      emailId: 'one',
      subject: 'Die <mark>Rechnung</mark>',
      preview: 'Hier ist die <mark>Rechnung</mark> von heute.',
    }]);
    expect(notFound).toEqual(['gone']);
  });

  it('escapes everything except its own marks', async () => {
    const hostile = 'Tom & <script>alert("x")</script> <mark>fake</mark> it\'s Rechnung &amp; more';
    const { snippets } = await storeWith([{ id: 'one', subject: hostile, ...withBody(hostile) }]);
    const { list } = await snippets({ text: 'rechnung' }, ['one']);
    const escaped = 'Tom &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &lt;mark&gt;fake&lt;/mark&gt; it&#39;s <mark>Rechnung</mark> &amp;amp; more';
    expect(list[0].subject).toBe(escaped);
    // The preview starts near the match, and is escaped the same way.
    expect(list[0].preview).toBe(escaped.slice(escaped.indexOf('&lt;mark&gt;')));
    // What the list shows: the markup as plain text, one highlighted word.
    expect(parseSearchSnippet(list[0].subject as string)).toEqual([
      { text: 'Tom & <script>alert("x")</script> <mark>fake</mark> it\'s ', marked: false },
      { text: 'Rechnung', marked: true },
      { text: ' &amp; more', marked: false },
    ]);
  });

  it('escapes a term that holds markup', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'a <b> c' }]);
    const { list } = await snippets({ subject: '"<b>"' }, ['one']);
    expect(list[0].subject).toBe('a &lt;<mark>b</mark>&gt; c');
  });

  it('marks the original text when diacritics or spelling differ', async () => {
    const { snippets } = await storeWith([
      { id: 'umlaut', subject: 'Frau Müller, MÜLLER' },
      { id: 'written', subject: 'Herr Mueller' },
    ]);
    expect((await snippets({ text: 'muller' }, ['umlaut'])).list[0].subject).toBe('Frau <mark>Müller</mark>, <mark>MÜLLER</mark>');
    expect((await snippets({ text: 'Mueller' }, ['umlaut'])).list[0].subject).toBe('Frau <mark>Müller</mark>, <mark>MÜLLER</mark>');
    expect((await snippets({ text: 'Müller' }, ['written'])).list[0].subject).toBe('Herr <mark>Mueller</mark>');
  });

  it('marks only where the index would have matched', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'zu zum Stromrechnung Rechnung' }]);
    expect((await snippets({ subject: 'zu' }, ['one'])).list[0].subject).toBe('<mark>zu</mark> zum Stromrechnung Rechnung');
    expect((await snippets({ subject: 'rechnung' }, ['one'])).list[0].subject).toBe('zu zum Strom<mark>rechnung</mark> <mark>Rechnung</mark>');
    expect((await snippets({ subject: 'rech*' }, ['one'])).list[0].subject).toBe('zu zum Stromrechnung <mark>Rech</mark>nung');
  });

  it('marks the words of the loosened filter the client sends', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'annual and report, budget' }]);
    const filter = buildJMAPFilter('"annual report" budg*', DEFAULT_SEARCH_FILTERS, 'inbox');
    const { list } = await snippets(snippetFilterFor(filter), ['one']);
    expect(list[0].subject).toBe('<mark>annual</mark> and <mark>report</mark>, <mark>budg</mark>et');
  });

  it('gives null for the part with no match, and for filters with nothing to mark', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'Betreff', from: alice, ...withBody('Inhalt hier') }]);
    expect((await snippets({ text: 'inhalt' }, ['one'])).list[0]).toEqual({ emailId: 'one', subject: null, preview: '<mark>Inhalt</mark> hier' });
    expect((await snippets({ text: 'betreff' }, ['one'])).list[0]).toEqual({ emailId: 'one', subject: '<mark>Betreff</mark>', preview: null });
    // subject and body only mark their own part.
    expect((await snippets({ subject: 'inhalt' }, ['one'])).list[0]).toEqual({ emailId: 'one', subject: null, preview: null });
    expect((await snippets({ body: 'betreff' }, ['one'])).list[0]).toEqual({ emailId: 'one', subject: null, preview: null });
    expect((await snippets({ from: 'alice' }, ['one'])).list[0]).toEqual({ emailId: 'one', subject: null, preview: null });
    expect((await snippets({ inMailbox: 'inbox' }, ['one'])).list[0]).toEqual({ emailId: 'one', subject: null, preview: null });
    expect((await snippets(null, ['one'])).list[0]).toEqual({ emailId: 'one', subject: null, preview: null });
  });

  it('does not mark terms the filter excludes', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'foo bar' }]);
    const { list } = await snippets({ operator: 'AND', conditions: [{ text: 'foo' }, { operator: 'NOT', conditions: [{ text: 'bar' }] }] }, ['one']);
    expect(list[0].subject).toBe('<mark>foo</mark> bar');
  });

  it('keeps a preview within 255 bytes, cuts no entity or mark, and starts near the match', async () => {
    const before = 'Wörter füllen den Anfang dieser Nachricht ganz ohne Treffer. '.repeat(20);
    const after = '& < > " \' ü '.repeat(200);
    const { snippets } = await storeWith([{ id: 'one', subject: 'x', ...withBody(`${before}\n\nDie   Rechnung ${after} Rechnung`) }]);
    const preview = (await snippets({ body: 'rechnung' }, ['one'])).list[0].preview as string;
    expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(255);
    expect(preview.length).toBeGreaterThan(200);
    expect(preview).toContain('Die <mark>Rechnung</mark> &amp; &lt;');
    expect(preview.indexOf('<mark>')).toBeLessThan(60);
    // Whatever is left over parses back with no half entity.
    expect(preview.replace(/<\/?mark>/g, '')).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
    expect(preview.split('<mark>').length).toBe(preview.split('</mark>').length);
  });

  it('never leaves an empty or open mark when the budget runs out on one', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'x', ...withBody(`foo ${'abcd '.repeat(48)}foo foo foo foo foo foo foo foo foo`) }]);
    const preview = (await snippets({ body: 'foo' }, ['one'])).list[0].preview as string;
    expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(255);
    expect(preview).not.toContain('<mark></mark>');
    expect(preview.split('<mark>').length).toBe(preview.split('</mark>').length);
  });

  it('builds the preview from an HTML body as plain text', async () => {
    const { snippets } = await storeWith([{
      id: 'one',
      subject: 'x',
      textBody: [],
      htmlBody: [{ partId: '1', type: 'text/html' }],
      ...withBody('<style>.rechnung{}</style><p class="rechnung">Ihre <b>Rechnung</b> von M&uuml;ller</p>'),
    }]);
    expect((await snippets({ body: 'rechnung' }, ['one'])).list[0].preview).toBe('Ihre <mark>Rechnung</mark> von Müller');
  });

  it('works chained onto the query, as the client asks for it', async () => {
    const { engine } = await storeWith([{ id: 'one', subject: 'Rechnung' }, { id: 'two', subject: 'Hallo' }]);
    const answer = await engine.answer([
      ['Email/query', { filter: { text: 'rechnung' } }, '0'],
      ['SearchSnippet/get', { filter: { text: 'rechnung' }, '#emailIds': { resultOf: '0', name: 'Email/query', path: '/ids' } }, 'snippets'],
    ]);
    expect(answer?.methodResponses[1][0]).toBe('SearchSnippet/get');
    expect(answer?.methodResponses[1][1].list).toEqual([{ emailId: 'one', subject: '<mark>Rechnung</mark>', preview: null }]);
  });

  it('answers per-call errors for bad arguments', async () => {
    const { engine } = await storeWith([]);
    const answer = await engine.answer([
      ['SearchSnippet/get', { filter: { text: 'x' } }, 'a'],
      ['SearchSnippet/get', { filter: { text: 'x' }, emailIds: Array.from({ length: 501 }, (_, i) => `e${i}`) }, 'b'],
      ['Mailbox/query', {}, 'c'],
    ]);
    expect(answer?.methodResponses[0]).toEqual(['error', expect.objectContaining({ type: 'invalidArguments' }), 'a']);
    expect(answer?.methodResponses[1]).toEqual(['error', expect.objectContaining({ type: 'requestTooLarge' }), 'b']);
  });

  it('caps the patterns one highlight can use, keeping it working', async () => {
    const words = Array.from({ length: 512 }, (_, i) => `wort${String(i).padStart(3, '0')}`);
    const { snippets } = await storeWith([{ id: 'one', subject: words.join(' ').slice(0, 1000) }]);
    const conditions = Array.from({ length: 32 }, (_, i) => ({ subject: words.slice(i * 16, i * 16 + 16).join(' ') }));
    const { list } = await snippets({ operator: 'AND', conditions }, ['one']);
    const marks = (list[0].subject as string).split('<mark>').length - 1;
    expect(marks).toBeGreaterThan(0);
    // The subject holds about 125 of the words, so more than this would be uncapped.
    expect(marks).toBeLessThanOrEqual(64);
  });

  it('caps how much of a subject it reads', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: `foo ${'x'.repeat(100_000)}` }]);
    const subject = (await snippets({ subject: 'foo' }, ['one'])).list[0].subject as string;
    expect(subject.startsWith('<mark>foo</mark>')).toBe(true);
    expect(subject.length).toBeLessThan(2_000);
  });

  it('survives hostile search terms', async () => {
    const { snippets } = await storeWith([{ id: 'one', subject: 'foo (bar) [baz]', ...withBody('foo (bar) [baz] \\ ^ $ . * + ? | /') }]);
    for (const text of ['(', ')', '[', ']', '\\', '^', '$', '.', '*', '+', '?', '|', '/', '(bar)', '[baz', 'a|b', '.*', '(?<x>', '\ud83d', 'foo\0bar']) {
      await expect(snippets({ text }, ['one']), text).resolves.toHaveProperty('list');
    }
    expect((await snippets({ text: '.*' }, ['one'])).list[0].preview).toBeNull();
    expect((await snippets({ text: '(bar)' }, ['one'])).list[0].subject).toBe('foo (<mark>bar</mark>) [baz]');
  });
});
