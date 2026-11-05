import { describe, expect, it } from 'vitest';
import { loadCatalog, loadFirstScreenCatalog } from '@/i18n/catalog';
import { FIRST_SCREEN_MESSAGES, fillIn, pickMessages } from '@/i18n/first-screen';

// The sign-in page and the mail view get only the first screen's part of the
// catalog (i18n/first-screen.ts). The whole catalog in the page was over 400 KB
// of script data on every cold start. That keys the first screen draws are in
// it is checked in a real browser by scripts/boot-skeleton-guard.

const size = (o: unknown) => JSON.stringify(o).length;
/** Every leaf of `o` as a dotted path. */
const leaves = (o: Record<string, unknown>, at = ''): string[] => Object.entries(o).flatMap(([k, v]) => (
  v && typeof v === 'object' && !Array.isArray(v) ? leaves(v as Record<string, unknown>, `${at}${k}.`) : [`${at}${k}`]
));

describe('the first screen catalog', () => {
  it('stays small, in every locale with plain wording and in one without', async () => {
    for (const locale of ['en', 'de', 'ja']) {
      const first = size(await loadFirstScreenCatalog(locale));
      expect(first, locale).toBeLessThan(60_000);
      expect(first, locale).toBeLessThan(size(await loadCatalog(locale)) / 4);
    }
  });

  it('names only paths the catalog has', async () => {
    const en = await loadCatalog('en');
    const all = new Set(leaves(en));
    for (const path of FIRST_SCREEN_MESSAGES) {
      expect([...all].some((leaf) => leaf === path || leaf.startsWith(`${path}.`)), path).toBe(true);
    }
  });

  it('holds every object of the catalog, so the rest can be laid into the same ones', async () => {
    const en = await loadCatalog('en');
    const first = await loadFirstScreenCatalog('en');
    const hoverActions = (first.settings as Record<string, Record<string, unknown>>).email_behavior.hover_actions;
    expect(hoverActions).toEqual({});
    fillIn(first, en);
    expect(first).toEqual(en);
    // Laid in, not replaced: a translator holding the empty object sees the strings now.
    expect(hoverActions).toBe((first.settings as Record<string, Record<string, unknown>>).email_behavior.hover_actions);
    expect(Object.keys(hoverActions as object).length).toBeGreaterThan(0);
  });

  it('takes a namespace whole or the named part of one, without touching the catalog', () => {
    const catalog = { a: { x: 'ax', y: 'ay' }, b: { c: { d: 'bcd', e: 'bce' }, f: 'bf' }, g: 'g' };
    const picked = pickMessages(catalog, ['b.c.d', 'a', 'a.x', 'g']);
    expect(picked).toEqual({ a: { x: 'ax', y: 'ay' }, b: { c: { d: 'bcd' } }, g: 'g' });
    expect(catalog.b.c).toEqual({ d: 'bcd', e: 'bce' });
  });
});
