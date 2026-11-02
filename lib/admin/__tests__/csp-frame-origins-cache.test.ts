// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The proxy builds frame-src from the plugins' frame origins and caches
// them for 5 s. It has its own copy of csp-frame-origins.ts, so clearing
// the cache from an install route used to clear only the route's copy: the
// proxy kept the old frame-src until its 5 s ran out. The cache is one per
// process now, and an install, update or removal clears it at once.

vi.mock('../third-party-mode', () => ({ isNoThirdPartyTrafficOn: vi.fn(async () => false) }));
vi.mock('../plugin-dev', () => ({ listDevPlugins: vi.fn(async () => []) }));

const PLUGIN = {
  id: 'video-embed', name: 'Video', version: '1.0.0', author: 'a', description: '', type: 'hook',
  permissions: [], entrypoint: 'index.js', enabled: true, installedAt: 'x', updatedAt: 'x',
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-csp-cache-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.admin.cspFrameOrigins')];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** A separate copy of the modules, as each bundle entry (proxy, route) has. */
async function moduleCopy() {
  vi.resetModules();
  return {
    origins: await import('../csp-frame-origins'),
    registry: await import('../plugin-registry'),
  };
}

async function writeRegistry(frameOrigins: string[]) {
  await mkdir(path.join(dir, 'plugins'), { recursive: true });
  await writeFile(path.join(dir, 'plugins', 'registry.json'), JSON.stringify({ plugins: [{ ...PLUGIN, frameOrigins }] }));
}

describe('plugin frame origins cache', () => {
  it('is cleared in the proxy copy when a route clears it', async () => {
    const proxyCopy = await moduleCopy();
    const routeCopy = await moduleCopy();
    await writeRegistry(['https://video.example.com']);
    expect(await proxyCopy.origins.getEnabledPluginFrameOrigins()).toEqual(['https://video.example.com']);

    await writeRegistry(['https://other.example.com']);
    routeCopy.origins.invalidateFrameOriginsCache();
    expect(await proxyCopy.origins.getEnabledPluginFrameOrigins()).toEqual(['https://other.example.com']);
  });

  it('is cleared in the proxy copy when a plugin is switched off', async () => {
    const proxyCopy = await moduleCopy();
    const routeCopy = await moduleCopy();
    await routeCopy.registry.savePlugin({ ...PLUGIN, frameOrigins: ['https://video.example.com'] }, 'code()');
    expect(await proxyCopy.origins.getEnabledPluginFrameOrigins()).toEqual(['https://video.example.com']);

    await routeCopy.registry.updatePluginMeta(PLUGIN.id, { enabled: false });
    expect(await proxyCopy.origins.getEnabledPluginFrameOrigins()).toEqual([]);
  });
});
