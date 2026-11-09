// @vitest-environment node
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { PLAIN_LANGUAGE_LOADERS } from '@/i18n/plain-language';

// locales/<code>/plain.json holds simpler versions of common.json strings for
// plain-language mode (CO-14). An override only works while its key path
// exists in common.json: a renamed or removed key would leave a dead override
// that nobody sees, so every path is checked here.

const localesDir = path.resolve(__dirname, '../../locales');

type Tree = Record<string, unknown>;

function leaves(node: unknown, prefix = ''): Array<[string, unknown]> {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return Object.entries(node as Tree).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, node]];
}

const load = (locale: string, file: string): Tree =>
  JSON.parse(fs.readFileSync(path.join(localesDir, locale, file), 'utf-8'));

// The arguments a message needs, from its parsed ICU form.
// Parsing also fails on a plain string that isn't valid ICU.
function icuArgs(text: string): string[] {
  const names = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const el of elements) {
      if ('value' in el && typeof el.value === 'string' && el.type !== TYPE.literal) names.add(el.value);
      if ('options' in el) Object.values(el.options).forEach((option) => walk(option.value));
      if ('children' in el) walk(el.children);
    }
  };
  // Tags stay literal: some strings hold HTML that is rendered raw.
  walk(parse(text, { ignoreTag: true }));
  return [...names].sort();
}

const plainLocales = fs.readdirSync(localesDir).filter((l) => fs.existsSync(path.join(localesDir, l, 'plain.json')));

describe('plain-language strings', () => {
  it('exist for English, German and Vietnamese only, each with a loader', () => {
    expect(plainLocales.sort()).toEqual(['de', 'en', 'vi']);
    expect(Object.keys(PLAIN_LANGUAGE_LOADERS).sort()).toEqual(['de', 'en', 'vi']);
  });

  for (const locale of plainLocales) {
    describe(locale, () => {
      const plain = leaves(load(locale, 'plain.json'));
      const common = new Map(leaves(load(locale, 'common.json')));

      it('has strings', () => {
        expect(plain.length).toBeGreaterThan(0);
      });

      it('only overrides keys that exist in common.json', () => {
        const dead = plain.map(([key]) => key).filter((key) => !common.has(key));
        expect(dead).toEqual([]);
      });

      it('only holds non-empty strings', () => {
        const bad = plain.filter(([, value]) => typeof value !== 'string' || !value.trim()).map(([key]) => key);
        expect(bad).toEqual([]);
      });

      it('keeps the placeholders of the string it replaces', () => {
        const mismatched = plain
          .filter(([key, value]) => JSON.stringify(icuArgs(String(value))) !== JSON.stringify(icuArgs(String(common.get(key)))))
          .map(([key]) => key);
        expect(mismatched).toEqual([]);
      });
    });
  }
});
