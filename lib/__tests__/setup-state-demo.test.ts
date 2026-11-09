// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configManager } from '@/lib/admin/config-manager';
import { detectSetupState } from '@/lib/setup/state';

let dir: string;

async function withConfig(config: Record<string, unknown>) {
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
  await configManager.reload();
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-setup-state-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('JMAP_SERVER_URL', '');
  vi.stubEnv('DEMO_MODE', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('detectSetupState', () => {
  it('sends a fresh install without a server to the wizard', async () => {
    await withConfig({});
    expect(detectSetupState()).toBe('bootstrap');
  });

  it('needs no wizard with DEMO_MODE=true and no JMAP_SERVER_URL', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    await withConfig({});
    expect(detectSetupState()).toBe('env-managed');
  });

  it('lets an admin override of demoMode win over DEMO_MODE', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    await withConfig({ demoMode: false });
    expect(detectSetupState()).toBe('bootstrap');
  });

  it('still reports a finished wizard as configured', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    await withConfig({ setupComplete: true });
    expect(detectSetupState()).toBe('configured');
  });
});
