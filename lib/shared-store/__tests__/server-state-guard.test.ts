// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SERVER_STATE_ALLOWLIST } from '../server-state-allowlist';
import { clientFilesImportingStore, findStateSites, repoRoot, scanServerState } from './server-state-scan';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Every replica must see the same state (#1066). State a route, the proxy
 * or instrumentation keeps in a module variable is per process, so it is
 * either a cache, per process by nature, or a bug. This fails when new
 * module-level state appears without going through lib/shared-store or
 * being listed in lib/shared-store/server-state-allowlist.ts with a reason.
 */

describe('server-side state goes through the shared store', () => {
  const sites = scanServerState();
  const found = new Map(sites.map((s) => [`${s.file}#${s.name}`, s]));
  const allowed = new Map(SERVER_STATE_ALLOWLIST.map((a) => [a.site, a]));

  it('has no module-level state that is neither shared nor listed', () => {
    const unlisted = [...found.entries()]
      .filter(([site]) => !allowed.has(site))
      .map(([site, s]) => `${site} (line ${s.line}): ${s.text}`);
    expect(unlisted, 'Move this state into lib/shared-store, or list it in server-state-allowlist.ts with its class and why').toEqual([]);
  });

  it('lists nothing that no longer exists', () => {
    const stale = [...allowed.keys()].filter((site) => !found.has(site));
    expect(stale, 'Remove these entries from server-state-allowlist.ts').toEqual([]);
  });

  it('gives every listed entry a reason', () => {
    expect(SERVER_STATE_ALLOWLIST.filter((a) => a.why.trim().length < 8)).toEqual([]);
  });

  it('keeps the shared store out of browser code', () => {
    expect(clientFilesImportingStore()).toEqual([]);
  });
});

describe('the scan', () => {
  it('finds the kinds of state it is meant to find, and skips constant tables', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bulwark-scan-'));
    try {
      const file = path.join(dir, 'sample.ts');
      writeFileSync(file, [
        "const ALLOWED = new Set(['a', 'b']);",
        'const sessions = new Map<string, number>();',
        'let counter = 0;',
        'const queue: string[] = [];',
        "const budget = createFailureBudget({ name: 'x' });",
        "const pattern = new RegExp('x');",
        'function f() {',
        '  let inner = 1;',
        '  return inner;',
        '}',
        "(globalThis as any)[KEY] ??= new Map();",
      ].join('\n'));
      const names = findStateSites(dir, file).map((s) => s.name);
      expect(names).toEqual(['sessions', 'counter', 'queue', 'budget', 'globalThis:KEY']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reaches the routes, the proxy and instrumentation', () => {
    const files = new Set(scanServerState(repoRoot()).map((s) => s.file));
    expect(files.has('app/api/favicon/route.ts')).toBe(true);
    expect([...files].some((f) => f.startsWith('stores/') || f.startsWith('components/'))).toBe(false);
  });
});
