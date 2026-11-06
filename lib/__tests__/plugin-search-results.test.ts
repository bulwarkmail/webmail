// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSearchResults, MAX_RESULTS_PER_PLUGIN, provideSearchResults } from '../plugin-search-results';
import { clearAllHooks, emailHooks } from '../plugin-hooks';

afterEach(() => {
  clearAllHooks();
  vi.useRealTimers();
});

describe('checkSearchResults', () => {
  it('keeps entries with a key and a title, as plain text, with the plugin', () => {
    expect(checkSearchResults('p', [
      { key: 'a', title: '  Pixel grid\n too coarse ', snippet: 'For our AR prototype', source: 'CRM', onClick: 'x', extra: 1 },
    ])).toEqual([{ pluginId: 'p', key: 'a', title: 'Pixel grid too coarse', snippet: 'For our AR prototype', source: 'CRM' }]);
  });

  it('drops what is not an entry, and a key given twice', () => {
    expect(checkSearchResults('p', [
      null, 'text', { title: 'no key' }, { key: 'a' }, { key: 7, title: 'number key' },
      { key: 'b', title: 'B' }, { key: 'b', title: 'B again' },
    ]).map((r) => r.key)).toEqual(['b']);
  });

  it('keeps the message an entry names, with its account', () => {
    expect(checkSearchResults('p', [
      { key: 'a', title: 'A', email: { id: 'M1', accountId: 'group-1', extra: true } },
      { key: 'b', title: 'B', email: { id: 'M2' } },
    ]).map((r) => r.email)).toEqual([{ id: 'M1', accountId: 'group-1' }, { id: 'M2' }]);
  });

  it('keeps an entry whose message is not one, without it', () => {
    const checked = checkSearchResults('p', [
      { key: 'a', title: 'A', email: 'M1' },
      { key: 'b', title: 'B', email: { id: '' } },
      { key: 'c', title: 'C', email: { id: 'M3', accountId: 7 } },
      { key: 'd', title: 'D', email: { id: 'x'.repeat(256) } },
    ]);
    expect(checked.map((r) => r.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(checked.every((r) => !('email' in r))).toBe(true);
  });

  it('keeps who an entry is from, when and how well it matches', () => {
    expect(checkSearchResults('p', [
      { key: 'a', title: 'A', from: '  Servershop24.de\n ', date: '2020-02-03T09:12:00+01:00', score: 0.8 },
    ])).toEqual([{
      pluginId: 'p', key: 'a', title: 'A', snippet: '',
      from: 'Servershop24.de', date: '2020-02-03T09:12:00+01:00', score: 0.8,
    }]);
  });

  it('drops a date Date cannot read and a score that is no number, holds a score within 0 to 1', () => {
    const checked = checkSearchResults('p', [
      { key: 'a', title: 'A', date: 'yesterday', score: '0.8', from: 7 },
      { key: 'b', title: 'B', date: `2020-02-03T09:12:00${'0'.repeat(40)}`, score: Number.NaN },
      { key: 'c', title: 'C', score: 3 },
      { key: 'd', title: 'D', score: -1 },
    ]);
    expect(checked.map(({ date, score, from }) => ({ date, score, from }))).toEqual([
      { date: undefined, score: undefined, from: undefined },
      { date: undefined, score: undefined, from: undefined },
      { date: undefined, score: 1, from: undefined },
      { date: undefined, score: 0, from: undefined },
    ]);
  });

  it('keeps the marks of a snippet and escapes everything else', () => {
    const [entry] = checkSearchResults('p', [
      { key: 'a', title: 'A', snippet: ' The <mark>pixel\n grid</mark> &amp; <b>more</b> <mark></mark>' },
    ]);
    expect(entry.snippet).toBe('The <mark>pixel grid</mark> &amp; &lt;b&gt;more&lt;/b&gt;');
  });

  it('escapes a plain snippet, so it reads back as written', () => {
    expect(checkSearchResults('p', [{ key: 'a', title: 'A', snippet: 'Tom & Jerry <3' }])[0].snippet)
      .toBe('Tom &amp; Jerry &lt;3');
  });

  it('cuts a snippet by its text, closing a mark it cuts', () => {
    const snippet = `${'x'.repeat(290)}<mark>${'y'.repeat(20)}</mark>`;
    const [entry] = checkSearchResults('p', [{ key: 'a', title: 'A', snippet }]);
    expect(entry.snippet).toBe(`${'x'.repeat(290)}<mark>${'y'.repeat(9)}</mark>…`);
  });

  it('ignores an answer that is not a list', () => {
    expect(checkSearchResults('p', { key: 'a', title: 'A' })).toEqual([]);
    expect(checkSearchResults('p', undefined)).toEqual([]);
  });

  it('cuts long texts and takes at most the limit per plugin', () => {
    const many = Array.from({ length: MAX_RESULTS_PER_PLUGIN + 5 }, (_, i) => ({ key: `k${i}`, title: 'x'.repeat(500), snippet: 'y'.repeat(900) }));
    const checked = checkSearchResults('p', many);
    expect(checked).toHaveLength(MAX_RESULTS_PER_PLUGIN);
    expect(checked[0].title.length).toBe(200);
    expect(checked[0].title.endsWith('…')).toBe(true);
    expect(checked[0].snippet.length).toBe(300);
  });
});

/** Asks the plugins, collecting each answer in the order it came. */
function ask(query = 'q') {
  const answers: { pluginId: string; keys: string[] }[] = [];
  const asked = provideSearchResults(query, {}, (pluginId, results) => {
    answers.push({ pluginId, keys: results.map((r) => r.key) });
  });
  return { asked, answers };
}

describe('provideSearchResults', () => {
  it('asks no one without handlers', () => {
    expect(ask().asked).toEqual([]);
  });

  it('asks the plugins at once, each with an empty list, and hands over each answer as it comes', async () => {
    const order: string[] = [];
    emailHooks.onProvideSearchResults.register('slow', async (initial: unknown[]) => {
      order.push(`slow ${initial.length}`);
      await new Promise((r) => setTimeout(r, 20));
      return [{ key: 's', title: 'S' }];
    });
    emailHooks.onProvideSearchResults.register('fast', (initial: unknown[]) => {
      order.push(`fast ${initial.length}`);
      return [{ key: 'f', title: 'F' }];
    });

    const { asked, answers } = ask();

    expect(asked).toEqual(['slow', 'fast']);
    expect(order).toEqual(['slow 0', 'fast 0']);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers).toEqual([{ pluginId: 'fast', keys: ['f'] }, { pluginId: 'slow', keys: ['s'] }]);
  });

  it('checks each answer', async () => {
    emailHooks.onProvideSearchResults.register('p', () => [{ key: 'a', title: 'A' }, { key: 'a', title: 'twice' }, 'text']);

    const { answers } = ask();

    await vi.waitFor(() => expect(answers).toEqual([{ pluginId: 'p', keys: ['a'] }]));
  });

  it('answers nothing for a plugin that throws', async () => {
    emailHooks.onProvideSearchResults.register('broken', () => { throw new Error('down'); });
    emailHooks.onProvideSearchResults.register('ok', () => [{ key: 'a', title: 'A' }]);

    const { answers } = ask();

    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers).toContainEqual({ pluginId: 'broken', keys: [] });
    expect(answers).toContainEqual({ pluginId: 'ok', keys: ['a'] });
  });

  it('answers nothing for a plugin that runs out of time, the others long before', async () => {
    vi.useFakeTimers();
    emailHooks.onProvideSearchResults.register('hung', () => new Promise(() => {}));
    emailHooks.onProvideSearchResults.register('ok', () => [{ key: 'a', title: 'A' }]);

    const { answers } = ask();
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toEqual([{ pluginId: 'ok', keys: ['a'] }]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(answers).toEqual([{ pluginId: 'ok', keys: ['a'] }, { pluginId: 'hung', keys: [] }]);
  });
});
