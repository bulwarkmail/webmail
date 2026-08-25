import { describe, it, expect } from 'vitest';
import { LOCALE_LOADERS } from '../intl-provider';
import { routing } from '@/i18n/routing';

/**
 * The client provider keeps its own per-locale loader map next to the ones in
 * i18n/routing.ts and i18n/request.ts. A locale wired into routing but absent
 * from the map falls back to `{}` and renders as English no matter what the
 * language picker says - exactly how Catalan shipped broken (#756) and
 * Mongolian arrived half-wired. Pin the map to the routing list so a new
 * locale cannot ship without its client messages again.
 */
describe('client message loader map', () => {
  it('carries a loader for every supported locale', () => {
    for (const locale of routing.locales) {
      expect(LOCALE_LOADERS[locale], `locale "${locale}" is missing from LOCALE_LOADERS`).toBeTypeOf('function');
    }
  });

  it('every loader resolves to a non-empty catalog', async () => {
    for (const locale of routing.locales) {
      const messages = await LOCALE_LOADERS[locale]();
      expect(Object.keys(messages).length, `locale "${locale}" has empty messages`).toBeGreaterThan(0);
    }
  });
});
