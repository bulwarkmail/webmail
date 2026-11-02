import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Finds module-level mutable state in everything the server runs: the route
 * handlers, the proxy (middleware), instrumentation, and every module they
 * import. Used by server-state-guard.test.ts so new state can't skip the
 * shared store without a reason (#1066).
 *
 * Heuristics, kept simple on purpose (the code base is consistently
 * formatted, so "top level" is "starts at column 0"):
 * - `let` / `var` at the top level;
 * - top-level `const x = new Something(`, except constructors of values that
 *   can't change (RegExp, URL, TextEncoder/TextDecoder, Intl.*, Error types);
 * - top-level `const x = []` / `{}` / `new Map()`… (empty containers, which
 *   only exist to be filled);
 * - top-level `const x = createSomethingBudget|Cache|Store|Limiter(`;
 * - any `globalThis` access that stores something (`??=`, `= new`, `[KEY] =`).
 *
 * Not counted: SCREAMING_CASE `new Set([...])` / `new Map([...])` lookup
 * tables, and the browser side (stores/, components/, 'use client' files).
 */

export interface StateSite {
  /** Repo-relative, forward slashes. */
  file: string;
  name: string;
  line: number;
  text: string;
}

const IMMUTABLE_CONSTRUCTORS = /^new (RegExp|URL|TextEncoder|TextDecoder|Intl\.\w+|Error|TypeError|RangeError|Date)\b/;

export function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(path.join(dir, 'package.json')) || !existsSync(path.join(dir, 'proxy.ts'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('repo root not found');
    dir = up;
  }
  return dir;
}

function walk(dir: string, out: string[], match: (file: string) => boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, match);
    else if (match(full)) out.push(full);
  }
}

export function serverEntries(root: string): string[] {
  const entries: string[] = [];
  walk(path.join(root, 'app'), entries, (f) => /[\\/]route\.tsx?$/.test(f) || /[\\/]manifest\.ts$/.test(f));
  for (const f of ['proxy.ts', 'instrumentation.ts', 'instrumentation.node.ts']) {
    if (existsSync(path.join(root, f))) entries.push(path.join(root, f));
  }
  return entries;
}

const IMPORT_PATTERNS = [
  /^\s*import\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
  /^\s*export\s+(?!type\s)[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function resolveImport(root: string, from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(root, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * The browser side the graph reaches through shared modules: zustand stores,
 * components and files marked 'use client'. Their state lives in the
 * browser, never in a route, so the walk stops there.
 */
function isBrowserSide(root: string, file: string): boolean {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.startsWith('stores/') || rel.startsWith('components/')) return true;
  return /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8'));
}

/** Every first-party file the server can load. */
export function serverFiles(root: string): string[] {
  const seen = new Set<string>();
  const queue = serverEntries(root);
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const resolved = resolveImport(root, file, match[1]);
        if (resolved && !seen.has(resolved) && !/\.test\.tsx?$/.test(resolved) && !isBrowserSide(root, resolved)) {
          queue.push(resolved);
        }
      }
    }
  }
  return [...seen].sort();
}

function stripBlockComments(source: string): string {
  // Keep line numbers: replace comment bodies with spaces/newlines.
  return source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

export function findStateSites(root: string, file: string): StateSite[] {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const lines = stripBlockComments(readFileSync(file, 'utf8')).split(/\r?\n/);
  const sites: StateSite[] = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '');
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/))) {
      sites.push({ file: rel, name: m[1], line: i + 1, text: raw.trim() });
      return;
    }
    if ((m = line.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/))) {
      const [, name, init] = m;
      const value = init.trim();
      // SCREAMING_CASE tables built once from a literal list are constants by convention.
      const constantTable = /^[A-Z][A-Z0-9_]*$/.test(name) && /^new (Set|Map)(<.*?>)?\(\s*\S/.test(value) && !/^new (Set|Map)(<.*?>)?\(\s*\)/.test(value);
      const isNew = /^new\s/.test(value) && !IMMUTABLE_CONSTRUCTORS.test(value) && !constantTable;
      const isEmpty = /^(\[\s*\]|\{\s*\})\s*(as\s.+)?;?$/.test(value);
      const isFactory = /^create\w*(Budget|Cache|Store|Limiter|Queue)\s*[(<]/.test(value);
      if (isNew || isEmpty || isFactory) sites.push({ file: rel, name, line: i + 1, text: raw.trim() });
      return;
    }
    if (/globalThis/.test(line) && /(\?\?=|\]\s*=[^=]|=\s*new\s)/.test(line)) {
      const key = line.match(/Symbol\.for\(\s*['"]([^'"]+)['"]\s*\)/)?.[1]
        ?? line.match(/\[\s*([A-Za-z_$][\w$]*)\s*\]/)?.[1]
        ?? line.match(/\.(__\w+)/)?.[1]
        ?? `globalThis@${i + 1}`;
      sites.push({ file: rel, name: `globalThis:${key}`, line: i + 1, text: raw.trim() });
    }
  });
  return sites;
}

export function scanServerState(root = repoRoot()): StateSite[] {
  return serverFiles(root).flatMap((file) => findStateSites(root, file));
}

/** Client components that import the shared store (they must not: it is server-only). */
export function clientFilesImportingStore(root = repoRoot()): string[] {
  const files: string[] = [];
  for (const dir of ['app', 'components', 'stores', 'hooks', 'lib', 'contexts']) {
    if (existsSync(path.join(root, dir))) walk(path.join(root, dir), files, (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  }
  return files
    .filter((f) => {
      const source = readFileSync(f, 'utf8');
      return /^\s*['"]use client['"]/.test(source) && /from\s+['"]@\/lib\/shared-store/.test(source);
    })
    .map((f) => path.relative(root, f).split(path.sep).join('/'));
}
