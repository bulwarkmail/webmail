// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_ENV_MAP } from '../types';

const ROOT = path.resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', '.next', '.git', 'repos', 'local-data', 'integration', '__tests__', 'out', 'public']);

function sourceFiles(dir = ROOT, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

describe('admin config map', () => {
  // A key in the map shows up in the admin API and can be saved, so one that
  // nothing reads is a setting that silently does nothing.
  it('has no key that nothing outside the map reads', () => {
    const typesFile = path.join(ROOT, 'lib', 'admin', 'types.ts');
    const texts = sourceFiles().filter((f) => f !== typesFile).map((f) => readFileSync(f, 'utf8'));
    const unread = Object.keys(CONFIG_ENV_MAP).filter(
      (key) => !texts.some((text) => new RegExp(`\\b${key}\\b`).test(text)),
    );
    expect(unread).toEqual([]);
  });
});
