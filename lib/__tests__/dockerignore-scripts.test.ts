import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

/** The scripts the image build can see: .dockerignore drops scripts/ and lists them one by one. */
function allowedScripts(): string[] {
  return readFileSync(join(ROOT, '.dockerignore'), 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('!scripts/'))
    .map((line) => line.slice(1));
}

function relativeImports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf-8');
  const found = source.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*|^import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm);
  return [...found]
    .map((match) => relative(ROOT, resolve(ROOT, dirname(file), match[1])).replace(/\\/g, '/'))
    .filter((target) => existsSync(join(ROOT, target)));
}

/** Every file under scripts/ reachable from what the Dockerfiles run. */
function scriptsNeededBy(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(join(ROOT, file))) continue;
    seen.add(file);
    if (/\.(mjs|cjs|js|ts)$/.test(file)) queue.push(...relativeImports(file));
  }
  return new Set([...seen].filter((file) => file.startsWith('scripts/')));
}

describe('.dockerignore', () => {
  it('lets through every script the image build imports', () => {
    const allowed = allowedScripts();
    const covered = (file: string) => allowed.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
    const entries = ['next.config.ts', ...allowed.filter((entry) => !entry.endsWith('/'))];
    const missing = [...scriptsNeededBy(entries)].filter((file) => !covered(file));
    expect(missing).toEqual([]);
  });

  it('sees the scripts next.config.ts imports', () => {
    expect(scriptsNeededBy(['next.config.ts'])).toContain('scripts/standalone-guard.mjs');
  });
});
