import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, IMPLICIT_PERMISSIONS } from '../plugin-types';
import { permissionKey } from '../plugin-sandbox/permission-text';

// Every permission a plugin can ask for is explained to the user in the
// consent dialog and in Settings > Plugins, in their language.

const LOCALES = path.resolve(__dirname, '../../locales');

describe('permission texts', () => {
  const implicit = new Set<string>(IMPLICIT_PERMISSIONS);
  const shown = ALL_PERMISSIONS.filter((p) => !implicit.has(p));
  const langs = readdirSync(LOCALES).filter((l) => !l.includes('.'));

  it('covers all 28 locales', () => {
    expect(langs).toHaveLength(28);
  });

  it.each(langs)('has a title and body for every permission in %s', (lang) => {
    const strings = JSON.parse(readFileSync(path.join(LOCALES, lang, 'common.json'), 'utf8'));
    const texts = strings.plugins?.permissions ?? {};
    const missing = shown.filter((p) => {
      const t = texts[permissionKey(p)];
      return !t || typeof t.title !== 'string' || !t.title.trim() || typeof t.body !== 'string' || !t.body.trim();
    });
    expect(missing).toEqual([]);
  });
});
