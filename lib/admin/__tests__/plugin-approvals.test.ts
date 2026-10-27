/**
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plugin-approvals-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('plugin approval requests', () => {
  it('keeps requests from several users that arrive at once', async () => {
    const { requestApproval, listApprovals } = await import('../plugin-approvals');
    const users = Array.from({ length: 8 }, (_, i) => `user${i}@example.org`);

    const results = await Promise.allSettled(users.map((user, i) =>
      requestApproval(`plugin-${i}x`, String(i).repeat(64), { name: `P${i}` }, user)));

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await listApprovals()).toHaveLength(8);
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'plugin-approvals.json'), 'utf-8'));
    expect(onDisk.entries).toHaveLength(8);
  });
});
