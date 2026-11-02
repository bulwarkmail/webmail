// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// What admins never see must not pile up (in the config dir or the shared
// store, #1066): the packages users sent for review are capped in total,
// the longest-decided going first, and kept-version folders without their
// entry.json (a copy cut short) are swept with the history.

const HASH = (c: string) => c.repeat(64);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-ext-growth-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.resetModules();
  for (const name of ['bulwark.admin.pluginApprovals', 'bulwark.admin.pluginRegistry', 'bulwark.admin.pluginSigning']) {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(name)];
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('packages kept for approval review', () => {
  it('drop the longest-decided package once they hold more than the cap, never a pending one', async () => {
    const approvals = await import('../plugin-approvals');
    approvals.setApprovalPackageCapForTests(10);
    const zip = new Uint8Array(6);

    await approvals.requestApproval('first-one', HASH('a'), {}, 'alice@example.org');
    await approvals.saveApprovalBundle('first-one', HASH('a'), zip);
    await approvals.decideApproval('first-one', HASH('a'), 'approved', 'admin');

    await approvals.requestApproval('second-one', HASH('b'), {}, 'bob@example.org');
    await approvals.saveApprovalBundle('second-one', HASH('b'), zip);
    await approvals.requestApproval('third-one', HASH('c'), {}, 'carol@example.org');
    await approvals.saveApprovalBundle('third-one', HASH('c'), zip);

    expect(await approvals.readApprovalBundle('first-one', HASH('a'))).toBeNull();
    // Over the cap now, but both are still pending: kept.
    expect(await approvals.readApprovalBundle('second-one', HASH('b'))).not.toBeNull();
    expect(await approvals.readApprovalBundle('third-one', HASH('c'))).not.toBeNull();
    expect((await approvals.listApprovals()).map((e) => [e.pluginId, e.packageBytes])).toEqual([
      ['first-one', undefined], ['second-one', 6], ['third-one', 6],
    ]);
    approvals.setApprovalPackageCapForTests(null);
  });
});

describe('extension history', () => {
  it('sweeps a kept-version folder that has no entry.json', async () => {
    const broken = path.join(dir, 'plugins', 'history', 'demo-plugin', '9.9.9');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'bundle.js'), 'half()');

    const registry = await import('../plugin-registry');
    const plugin = { id: 'demo-plugin', name: 'D', version: '1.0.0', author: 'a', description: '', type: 'hook', permissions: [], entrypoint: 'index.js', enabled: true, installedAt: 'x', updatedAt: 'x' };
    await registry.savePlugin(plugin, 'v1()');
    await registry.savePlugin({ ...plugin, version: '1.1.0' }, 'v2()');

    expect(existsSync(broken)).toBe(false);
    expect(existsSync(path.join(dir, 'plugins', 'history', 'demo-plugin', '1.0.0', 'entry.json'))).toBe(true);
  });
});
