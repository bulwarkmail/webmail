import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The amd64 and arm64 builds of one release run the same code. Each must get
// the same build id, or a load balancer sending a tab's /api/version check to
// the other architecture makes the tab announce a new version (#1531).

async function buildIdFor(seed: string | undefined): Promise<string> {
  vi.resetModules();
  vi.stubEnv('BULWARK_BUILD_ID', '');
  vi.stubEnv('BULWARK_BUILD_SEED', seed ?? '');
  await import('../../next.config');
  return process.env.BULWARK_BUILD_ID ?? '';
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('build id', () => {
  it('is the same for two builds with the same seed', async () => {
    const first = await buildIdFor('abc123-42-1');
    const second = await buildIdFor('abc123-42-1');
    expect(first).toMatch(/^[\w-]{16}$/);
    expect(second).toBe(first);
    expect(first).not.toContain('abc123');
  });

  it('differs between seeds, and between unseeded builds', async () => {
    expect(await buildIdFor('abc123-42-1')).not.toBe(await buildIdFor('abc123-43-1'));
    expect(await buildIdFor(undefined)).not.toBe(await buildIdFor(undefined));
  });

  it('gets one seed per workflow run in every image build', () => {
    const root = join(__dirname, '..', '..');
    expect(readFileSync(join(root, 'Dockerfile'), 'utf-8')).toMatch(/ARG BULWARK_BUILD_SEED=\s+ENV BULWARK_BUILD_SEED=\$BULWARK_BUILD_SEED/);
    for (const workflow of ['docker-publish.yml', 'docker-publish-releases.yml']) {
      const text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf-8');
      const builds = text.split('build-args: |').length - 1;
      const seeded = text.split('BULWARK_BUILD_SEED=${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}').length - 1;
      expect(builds, workflow).toBeGreaterThan(0);
      expect(seeded, workflow).toBe(builds);
    }
  });
});
