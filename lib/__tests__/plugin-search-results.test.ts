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

describe('provideSearchResults', () => {
  it('asks no one without handlers', async () => {
    expect(await provideSearchResults('q', {})).toEqual([]);
  });

  it('asks the plugins at once, each with an empty list', async () => {
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

    const results = await provideSearchResults('q', {});

    expect(order).toEqual(['slow 0', 'fast 0']);
    expect(results.map((r) => `${r.pluginId}:${r.key}`)).toEqual(['slow:s', 'fast:f']);
  });

  it('leaves out a plugin that throws', async () => {
    emailHooks.onProvideSearchResults.register('broken', () => { throw new Error('down'); });
    emailHooks.onProvideSearchResults.register('ok', () => [{ key: 'a', title: 'A' }]);

    expect((await provideSearchResults('q', {})).map((r) => r.pluginId)).toEqual(['ok']);
  });

  it('leaves out a plugin that runs out of time', async () => {
    vi.useFakeTimers();
    emailHooks.onProvideSearchResults.register('hung', () => new Promise(() => {}));
    emailHooks.onProvideSearchResults.register('ok', () => [{ key: 'a', title: 'A' }]);

    const pending = provideSearchResults('q', {});
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await pending).map((r) => r.pluginId)).toEqual(['ok']);
  });
});
