// @vitest-environment node
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// settings-35 (2026-11-04): "Reply from the address it was sent to" ended
// with "…is set by “Received Address Matching” below", a row that only shows
// when the admin allows custom From addresses, under another name. The
// description says what the switch does and points nowhere.
const KEY = ['settings', 'email_behavior', 'auto_select_reply_identity', 'description'];
const POINTERS: Record<string, RegExp> = {
  en: /below|Received Address Matching/i,
  de: /unten|darunter/i,
  vi: /bên dưới|Khớp địa chỉ nhận/i,
  et: /allpool|sobitamine/i,
  th: /ด้านล่าง/,
};

const localesDir = path.resolve(__dirname, '../../locales');

function read(locale: string, file: string): unknown {
  const p = path.join(localesDir, locale, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined;
}

function at(obj: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined), obj);
}

describe('reply identity description', () => {
  it.each(Object.keys(POINTERS))('doesn\'t point to a row below in %s', (locale) => {
    for (const file of ['common.json', 'plain.json']) {
      const text = at(read(locale, file), KEY);
      if (typeof text === 'string') expect(text).not.toMatch(POINTERS[locale]);
    }
  });
});

// settings-36 (2026-11-04): Backup & reset said "JSON", "Upload settings from
// JSON file" and "— fixes a stale or wrong view"; the offline storage note's
// button said "Ask again" without saying what it asks.
describe('backup and offline wording', () => {
  const locales = fs.readdirSync(localesDir).filter((l) => fs.statSync(path.join(localesDir, l)).isDirectory());

  it.each(locales)('%s: no JSON in the settings file rows, no dash aside in Refresh', (locale) => {
    for (const file of ['common.json', 'plain.json']) {
      const messages = read(locale, file);
      for (const row of ['export_settings', 'import_settings']) {
        const text = at(messages, ['settings', 'advanced', row, 'description']);
        if (typeof text === 'string') expect(text).not.toMatch(/json/i);
      }
      const refresh = at(messages, ['settings', 'advanced', 'refresh_cache', 'description']);
      if (typeof refresh === 'string') expect(refresh).not.toMatch(/—/);
    }
  });

  it('says what the storage button asks for', () => {
    expect(at(read('en', 'common.json'), ['offlineStorage', 'persist_retry'])).toBe('Ask the browser to keep it');
  });
});
