// @vitest-environment node
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(__dirname, '../..');
const localesDir = path.join(rootDir, 'locales');
const referenceLocale = 'en';

function getLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...getLeafKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

function loadLocale(locale: string): Record<string, unknown> {
  const filePath = path.join(localesDir, locale, 'common.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function resolveKey(obj: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), obj);
}

// Collect source files recursively
function getSourceFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__tests__') {
      results.push(...getSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extract translation keys from source, respecting which variable maps to which namespace.
 * Handles multiple useTranslations calls per file (even reusing the same variable name
 * in different functions) by finding, for each t("key") call, the nearest preceding
 * useTranslations assignment to that variable.
 */
function extractUsedKeys(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const keys: string[] = [];

  // Collect all variable→namespace assignments with their positions
  const assignRegex = /const\s+(\w+)\s*=\s*useTranslations\(\s*["']([^"']*)["']\s*\)/g;
  const assignments: { varName: string; namespace: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = assignRegex.exec(content)) !== null) {
    assignments.push({ varName: m[1], namespace: m[2], index: m.index });
  }

  if (assignments.length === 0) return keys;

  // Get unique variable names
  const varNames = [...new Set(assignments.map((a) => a.varName))];

  // For each variable, find its t("key") calls and resolve namespace by position
  for (const varName of varNames) {
    const varAssignments = assignments.filter((a) => a.varName === varName);
    const callRegex = new RegExp(`\\b${varName}\\(\\s*["']([^"'{}]+)["']`, 'g');
    while ((m = callRegex.exec(content)) !== null) {
      const key = m[1];
      // Find the nearest preceding assignment for this variable
      const ns = varAssignments
        .filter((a) => a.index < m!.index)
        .sort((a, b) => b.index - a.index)[0]?.namespace;
      if (ns === undefined) continue;
      keys.push(ns ? `${ns}.${key}` : key);
    }
  }

  return [...new Set(keys)];
}

function collectUsedKeysByFile(files: string[]): Map<string, string[]> {
  const keyToFiles = new Map<string, string[]>();

  for (const filePath of files) {
    for (const key of extractUsedKeys(filePath)) {
      const existing = keyToFiles.get(key) ?? [];
      if (!existing.includes(filePath)) {
        existing.push(filePath);
        keyToFiles.set(key, existing);
      }
    }
  }

  return keyToFiles;
}

const locales = fs
  .readdirSync(localesDir)
  .filter((entry) => fs.statSync(path.join(localesDir, entry)).isDirectory());

const referenceData = loadLocale(referenceLocale);
const referenceKeys = getLeafKeys(referenceData);

describe('translations completeness', () => {
  it('reference locale (en) should have keys', () => {
    expect(referenceKeys.length).toBeGreaterThan(0);
  });

  const otherLocales = locales.filter((l) => l !== referenceLocale);

  it.each(otherLocales)('%s should have all keys from en', (locale) => {
    const localeKeys = new Set(getLeafKeys(loadLocale(locale)));
    const missing = referenceKeys.filter((key) => !localeKeys.has(key));

    expect(missing, `Missing ${missing.length} keys in "${locale}":\n${missing.join('\n')}`).toEqual([]);
  });

  it.each(otherLocales)('%s should not have extra keys absent from en', (locale) => {
    const localeKeys = getLeafKeys(loadLocale(locale));
    const referenceSet = new Set(referenceKeys);
    const extra = localeKeys.filter((key) => !referenceSet.has(key));

    expect(extra, `Extra ${extra.length} keys in "${locale}":\n${extra.join('\n')}`).toEqual([]);
  });
});

describe('translations used in source code exist in en locale', () => {
  const srcDirs = ['components', 'app', 'hooks', 'lib', 'stores', 'contexts'].map((d) => path.join(rootDir, d));
  const allFiles = srcDirs.flatMap((d) => getSourceFiles(d));
  const usedKeysByFile = collectUsedKeysByFile(allFiles);
  const usedKeys = [...usedKeysByFile.keys()].sort();

  it('all translation keys referenced in source should exist in en locale', () => {
    const missing = usedKeys.filter((key) => resolveKey(referenceData, key) === undefined);
    const details = missing.map((key) => {
      const relativeFiles = (usedKeysByFile.get(key) ?? [])
        .map((filePath) => path.relative(rootDir, filePath))
        .sort();

      return `${key}\n  used in:\n  - ${relativeFiles.join('\n  - ')}`;
    });

    expect(
      missing,
      `${missing.length} translation key(s) used in source code but missing from en locale:\n${details.join('\n')}`,
    ).toEqual([]);
  });
});

describe('mail terms are not mistranslated', () => {
  const locales = fs.readdirSync(localesDir).filter((l) => l !== referenceLocale);

  // "Composer" was translated as the music composer (or a printer in tr) in
  // several languages, and "Create" as "manufacture" in mn.
  const WRONG_WORDS: Record<string, RegExp> = {
    da: /komponist/i,
    es: /\bcompositor/i,
    fr: /compositeur/i,
    it: /\bcompositore/i,
    mn: /Хөгжмийн зохиолч|Үйлдвэрлэх/,
    pt: /\bcompositor/i,
    ro: /compozitor/i,
    tr: /yazıcı/i,
    uk: /композитор/i,
  };

  // The desktop print preview is about real printers: "yazıcı" is the right word there.
  const ABOUT_PRINTERS = /^desktopPrint\./;

  it.each(Object.keys(WRONG_WORDS))('%s does not call the composer a music composer or a printer', (locale) => {
    const table = loadLocale(locale);
    const wrong = getLeafKeys(table)
      .filter((key) => !ABOUT_PRINTERS.test(key))
      .map((key) => [key, resolveKey(table, key)] as const)
      .filter(([, value]) => typeof value === 'string' && WRONG_WORDS[locale].test(value));
    expect(wrong).toEqual([]);
  });

  // A certificate's subject is its holder, not an email's subject line.
  // Turkish keeps "Konu", the word Windows' certificate dialog uses.
  it.each(locales.filter((l) => l !== 'tr'))('%s names the certificate subject differently from the email subject', (locale) => {
    const table = loadLocale(locale);
    expect(resolveKey(table, 'smime.cert_subject')).not.toBe(resolveKey(table, 'email_composer.subject'));
  });
});

describe('links in translations', () => {
  // The docs live on bulwarkmail.org. A path like /docs/... opens on the
  // webmail's own host, where there is no such page (#1387).
  it.each(locales)('%s links only to absolute URLs', (locale) => {
    const table = loadLocale(locale);
    const relative = getLeafKeys(table).filter((key) => {
      const value = resolveKey(table, key);
      return typeof value === 'string' && /href="(?!https:\/\/)/.test(value);
    });
    expect(relative).toEqual([]);
  });
});

describe('labels in narrow places', () => {
  // The mail search field in the list column (167px at 1440, with the "/"
  // key cap) cut "E-Mails durchsuchen..." to "E-Mails durchsu". The English
  // text fits; a translation may not be longer.
  const en = loadLocale(referenceLocale);
  const max = (resolveKey(en, 'sidebar.search_placeholder') as string).length;
  it.each(locales)('%s keeps the mail search placeholder as short as the English one', (locale) => {
    const value = resolveKey(loadLocale(locale), 'sidebar.search_placeholder') as string;
    expect(value.length).toBeLessThanOrEqual(max);
  });
});

describe('mail menu labels', () => {
  // An item that opens a dialog ends in one "…" character; one that opens a
  // submenu or acts at once has none, and no "(?)" key hint. English follows
  // the rule; translations had "...", "…" on submenus, or nothing (#67).
  const en = loadLocale(referenceLocale);
  const MENUS = ['context_menu', 'mailbox_context_menu', 'email_viewer'];
  // Progress and placeholder texts ("Sending...") aren't menu items.
  const menuKeys = getLeafKeys(en).filter((key) => {
    if (!MENUS.includes(key.split('.')[0])) return false;
    const value = resolveKey(en, key) as string;
    return typeof value === 'string' && !value.endsWith('...') && !/loading|placeholder|running|sending|migrating/.test(key);
  });
  const ending = (value: string) => (value.endsWith('…') ? '…' : value.endsWith('...') ? '...' : '');

  it.each(locales)('%s ends mail menu items in an ellipsis only where English does', (locale) => {
    const table = loadLocale(locale);
    const wrong = menuKeys
      .map((key) => [key, resolveKey(table, key)] as const)
      .filter(([key, value]) => typeof value === 'string' && ending(value.trimEnd()) !== ending(resolveKey(en, key) as string))
      .map(([key, value]) => `${key}: ${value}`);
    expect(wrong).toEqual([]);
  });

  it.each(locales)('%s names the reader menu shortcuts item without a key hint', (locale) => {
    expect(resolveKey(loadLocale(locale), 'email_viewer.keyboard_shortcuts')).not.toMatch(/[(（][?？؟][)）]/);
  });
});

describe('message counts', () => {
  // The phone conversation said "3 رسالة": it used the hand-made "other"
  // form for every count, and several plural messages missed the forms
  // their language has (Arabic two/few/many, Russian few).
  const KEYS = ['threads.messages_count', 'threads.messages_tooltip'];
  const branches = (message: string) => new Set([...message.matchAll(/(?:^|[}\s,])(zero|one|two|few|many|other)\s*\{/g)].map((m) => m[1]));

  it.each(locales)('%s has a plural form for every whole count', (locale) => {
    const table = loadLocale(locale);
    const rules = new Intl.PluralRules(locale);
    const needed = new Set<string>();
    for (let n = 0; n <= 200; n++) needed.add(rules.select(n));
    const missing = KEYS.flatMap((key) => {
      const message = resolveKey(table, key);
      if (typeof message !== 'string' || !message.includes('plural')) return [`${key}: not a plural message`];
      const have = branches(message);
      return [...needed].filter((form) => !have.has(form)).map((form) => `${key}: ${form}`);
    });
    expect(missing).toEqual([]);
  });
});
