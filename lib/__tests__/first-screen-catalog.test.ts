import { describe, expect, it } from 'vitest';
import { loadCatalog, loadFirstScreenCatalog } from '@/i18n/catalog';
import { FIRST_SCREEN_MESSAGES, READER_FIRST_SCREEN_MESSAGES, fillIn, opensReader, pickMessages } from '@/i18n/first-screen';

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

  it('adds the reader for a message or conversation opened from a link, and only there', async () => {
    expect(opensReader('/en/mail/message/m1')).toBe(true);
    expect(opensReader('/mail/thread/t1')).toBe(true);
    expect(opensReader('/en/mail/folder/inbox')).toBe(false);
    expect(opensReader('/en')).toBe(false);
    for (const locale of ['en', 'de']) {
      const list = size(await loadFirstScreenCatalog(locale, '/en/mail/folder/inbox'));
      const reader = await loadFirstScreenCatalog(locale, '/en/mail/message/m1');
      expect(size(reader), locale).toBeGreaterThan(list);
      expect(size(reader), locale).toBeLessThan(75_000);
      // Every string of the reader's buttons and header, not just the ones the list draws.
      expect(reader.email_viewer, locale).toEqual((await loadCatalog(locale)).email_viewer);
    }
  });

  it("has the sign-in page's notices, which draw on its first screen", async () => {
    // Why the session ended, a wipe, mail the outbox lost (app/(main)/[locale]/login/page.tsx).
    // The sign-in page holds the rest of the catalog back (lib/sign-in-hold.ts): a notice
    // left out of this part would stay blank there for seconds.
    const notices = [
      'session_limits.reason_idle', 'session_limits.reason_max', 'session_limits.drafts_not_saved',
      'offlineWipe.note', 'offlineWipe.note_unsent', 'offlineWipe.note_unknown',
      'offlineWipe.session_waiting', 'offlineWipe.session_waiting_unknown', 'offlineWipe.refused_waiting', 'offlineWipe.refused_waiting_unknown',
      'offline.signout.lost', 'offline.outbox.no_subject',
    ];
    for (const locale of ['en', 'de']) {
      const first = await loadFirstScreenCatalog(locale, '/en/login');
      const have = new Set(leaves(first));
      for (const key of notices) expect([...have].some((leaf) => leaf === key || leaf.startsWith(`${key}.`)), `${locale} ${key}`).toBe(true);
    }
  });

  it('includes the empty Smart Folder sidebar create entry before the full catalog loads', async () => {
    for (const locale of ['en', 'de', 'ja']) {
      const first = await loadFirstScreenCatalog(locale, '/en');
      const full = await loadCatalog(locale);
      expect((first.smart_folders as Record<string, unknown>).create, locale)
        .toBe((full.smart_folders as Record<string, unknown>).create);
      expect((first.smart_folders as Record<string, unknown>).create, locale).toBeTruthy();
      expect(first.smart_folders, locale).toEqual(full.smart_folders);
    }
  });

  it('names only paths the catalog has', async () => {
    const en = await loadCatalog('en');
    const all = new Set(leaves(en));
    for (const path of [...FIRST_SCREEN_MESSAGES, ...READER_FIRST_SCREEN_MESSAGES]) {
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
