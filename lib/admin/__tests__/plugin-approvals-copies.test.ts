// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Next makes one copy of plugin-approvals.ts per bundle entry. Each copy
// loaded the approvals file once and kept it: a request taken by the
// approval-status route never reached the admin route's copy, a decision
// there never reached the plugin-secrets gate, and the next write of any
// copy put its old list back over the others' changes.

const HASH = 'b'.repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-approvals-copies-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.admin.pluginApprovals')];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function moduleCopy() {
  vi.resetModules();
  return import('../plugin-approvals');
}

describe('plugin approvals across module copies', () => {
  it('shows a request and its decision to every copy at once', async () => {
    const statusRoute = await moduleCopy();
    const adminRoute = await moduleCopy();
    const gate = await moduleCopy();
    // Each copy has read the (empty) file already.
    expect(await adminRoute.listApprovals()).toEqual([]);
    expect(await gate.listApprovals()).toEqual([]);

    await statusRoute.requestApproval('cloud-sync', HASH, { name: 'Cloud' }, 'alice@example.org');
    expect((await adminRoute.listApprovals()).map((e) => e.status)).toEqual(['pending']);

    await adminRoute.decideApproval('cloud-sync', HASH, 'approved', 'admin');
    expect(await gate.getApprovalStatus('cloud-sync', HASH)).toMatchObject({ status: 'approved' });
    expect(await statusRoute.getApprovalStatus('cloud-sync', HASH)).toMatchObject({ status: 'approved' });
  });
});
