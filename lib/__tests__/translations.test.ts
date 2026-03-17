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
      if (key.startsWith('.')) continue;
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
