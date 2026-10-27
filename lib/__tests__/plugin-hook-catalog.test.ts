// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { HOOK_CATALOG, type HookGroup } from '../plugin-hook-catalog';
import * as hooks from '../plugin-hooks';
import { ALL_PERMISSIONS } from '../plugin-types';

const root = path.resolve(__dirname, '../..');

/** Every HookBus by name, from all the exported hook groups. */
function allBuses(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [groupName, group] of Object.entries(hooks)) {
    if (!groupName.endsWith('Hooks') || typeof group !== 'object' || group === null) continue;
    for (const [hookName, bus] of Object.entries(group)) {
      if (bus instanceof hooks.HookBus) out[hookName] = groupName;
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'repos', '__tests__', '.git', 'local-data', 'integration', 'scripts'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

const sources = ['app', 'components', 'contexts', 'hooks', 'lib', 'stores'].flatMap((d) => sourceFiles(path.join(root, d)))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

/** A call site that fires the hook: `xHooks.onFoo.emit(` and friends. */
function isFired(hookName: string, groupName: string): boolean {
  const re = new RegExp(`\\b${groupName}\\.${hookName}\\s*\\.(emit|emitSync|emitTo|intercept|interceptOutcome|interceptWithValue|transform|takeOver|collect)\\b`);
  return re.test(sources);
}

// Groups whose call sites are still being wired in this branch. Each
// commit that wires a group removes it here, and the test then insists every
// hook in it has a call site.
const NOT_YET_WIRED = new Set<HookGroup>([]);

describe('hook catalogue', () => {
  const buses = allBuses();

  it('has a bus for every catalogued hook and no bus without an entry', () => {
    expect(Object.keys(buses).sort()).toEqual(Object.keys(HOOK_CATALOG).sort());
  });

  it('gates every hook behind a permission the host knows', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    const unknown = Object.entries(HOOK_CATALOG).filter(([, spec]) => !known.has(spec.permission)).map(([n]) => n);
    expect(unknown).toEqual([]);
  });

  const groups = [...new Set(Object.values(HOOK_CATALOG).map((s) => s.group))];
  it.each(groups)('fires every %s hook somewhere in the app', (group) => {
    const missing = Object.entries(HOOK_CATALOG)
      .filter(([name, spec]) => spec.group === group && !isFired(name, buses[name]))
      .map(([name]) => name);
    if (NOT_YET_WIRED.has(group)) {
      // Still being wired: the list must not claim a group is unwired once
      // it is fully wired, or the check would never switch on.
      expect(missing.length, `${group} is fully wired; remove it from NOT_YET_WIRED`).toBeGreaterThan(0);
    } else {
      expect(missing).toEqual([]);
    }
  });
});
