import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'use-intl/core';
import { shellLabels } from '../languages';

/**
 * The real catalogs through the real formatter, which the vitest next-intl mock isn't.
 * A string that needs a value and doesn't get one is an error here. In the app it's a
 * logged error, and the desktop's menu would show the key instead of the label.
 */
const LOCALES_DIR = join(process.cwd(), 'locales');
const LOCALES = readdirSync(LOCALES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

function labelsFor(locale: string): { labels: Record<string, string>; errors: string[] } {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'common.json'), 'utf8'));
  const errors: string[] = [];
  const t = createTranslator({
    locale,
    messages,
    onError: (error) => { errors.push(`${locale}: ${error.message.slice(0, 160)}`); },
  });
  return { labels: shellLabels(t as unknown as Parameters<typeof shellLabels>[0]), errors };
}

describe('the labels the desktop shell gets', () => {
  it('finds every language', () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(LOCALES)('%s: every string formats, with no value missing', (locale) => {
    const { labels, errors } = labelsFor(locale);
    expect(errors).toEqual([]);
    for (const [name, label] of Object.entries(labels)) {
      expect(label, name).not.toMatch(/^[\w-]+(\.[\w-]+)+$/);
      expect(label.trim(), name).not.toBe('');
    }
  });

  it('names File > Unlock, which the menus offer while the app is locked', () => {
    expect(labelsFor('de').labels.menuUnlock).toBe('Entsperren');
    expect(labelsFor('en').labels.menuUnlock).toBe('Unlock');
  });

  it.each(LOCALES)('%s: leaves the shell its placeholders to fill in', (locale) => {
    const { labels } = labelsFor(locale);
    expect(labels.contextAddToDictionary).toContain('{word}');
    expect(labels.unsentMany).toContain('{count}');
  });
});
