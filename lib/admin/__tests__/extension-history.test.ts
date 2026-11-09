/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-ext-history-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const PLUGIN = {
  id: 'demo', name: 'Demo', version: '1.0.0', author: 'a', description: '', type: 'hook',
  permissions: [], entrypoint: 'index.js', enabled: true, installedAt: 'x', updatedAt: 'x',
  source: { kind: 'marketplace' as const, slug: 'demo', directoryUrl: 'https://extensions.test' },
};

const THEME = {
  id: 'night', name: 'Night', version: '1.0.0', author: 'a', description: '', variants: ['dark'],
  enabled: true, installedAt: 'x', updatedAt: 'x',
};

describe('plugin history', () => {
  it('keeps the version being replaced and restores it', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');

    await registry.savePlugin(PLUGIN, 'v1()');
    expect(await history.listHistory('plugin', 'demo')).toEqual([]);

    await registry.savePlugin({ ...PLUGIN, version: '1.1.0' }, 'v2()');
    const kept = await history.listHistory('plugin', 'demo');
    expect(kept.map((e) => e.version)).toEqual(['1.0.0']);
    expect(kept[0].source).toEqual(PLUGIN.source);

    const restored = await history.readHistoryEntry('plugin', 'demo', '1.0.0');
    expect(restored.code).toBe('v1()');
    expect(restored.entry.version).toBe('1.0.0');
    expect(restored.entry.bundleHash).toHaveLength(64);
  });

  it('does not keep a save of the same version with the same bytes', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.savePlugin(PLUGIN, 'same()');
    await registry.savePlugin(PLUGIN, 'same()');
    expect(await history.listHistory('plugin', 'demo')).toEqual([]);
  });

  it('keeps a re-upload of the same version when the code changed', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.savePlugin(PLUGIN, 'first()');
    await registry.savePlugin(PLUGIN, 'second()');
    const kept = await history.listHistory('plugin', 'demo');
    expect(kept.map((e) => e.version)).toEqual(['1.0.0']);
    expect((await history.readHistoryEntry('plugin', 'demo', '1.0.0')).code).toBe('first()');
  });

  it('keeps only the last five replaced versions', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    for (let i = 0; i < 8; i++) {
      await registry.savePlugin({ ...PLUGIN, version: `1.${i}.0` }, `v${i}()`);
    }
    const kept = await history.listHistory('plugin', 'demo');
    expect(kept).toHaveLength(5);
    // 1.7.0 is installed; 1.2.0 to 1.6.0 are kept, newest replacement first.
    expect(kept.map((e) => e.version)).toEqual(['1.6.0', '1.5.0', '1.4.0', '1.3.0', '1.2.0']);
  });

  it('refuses a kept copy whose bytes were changed on disk', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.savePlugin(PLUGIN, 'v1()');
    await registry.savePlugin({ ...PLUGIN, version: '1.1.0' }, 'v2()');

    const root = path.join(dir, 'plugins', 'history', 'demo');
    const [entryDir] = await readdir(root);
    await writeFile(path.join(root, entryDir, 'bundle.js'), 'stealEverything()', 'utf-8');

    await expect(history.readHistoryEntry('plugin', 'demo', '1.0.0')).rejects.toMatchObject({ status: 409 });
  });

  it('answers 404 for a version that was never kept', async () => {
    const history = await import('../extension-history');
    await expect(history.readHistoryEntry('plugin', 'demo', '9.9.9')).rejects.toMatchObject({ status: 404 });
  });

  it('forgets the history when the plugin is uninstalled', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.savePlugin(PLUGIN, 'v1()');
    await registry.savePlugin({ ...PLUGIN, version: '1.1.0' }, 'v2()');
    await registry.deletePlugin('demo');
    expect(await history.listHistory('plugin', 'demo')).toEqual([]);
  });

  it('lets a rollback be rolled back', async () => {
    // Restoring goes through savePlugin, which keeps the version it replaces.
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.savePlugin(PLUGIN, 'v1()');
    await registry.savePlugin({ ...PLUGIN, version: '1.1.0' }, 'v2()');

    const back = await history.readHistoryEntry('plugin', 'demo', '1.0.0');
    await registry.savePlugin(back.entry, back.code);

    expect((await registry.getPlugin('demo'))?.version).toBe('1.0.0');
    expect(await registry.getPluginBundle('demo')).toBe('v1()');
    expect((await history.listHistory('plugin', 'demo')).map((e) => e.version)).toEqual(['1.1.0']);
  });

  it("keeps a version's changelog with its copy and lists it for the admin", async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.savePlugin({ ...PLUGIN, changelog: '- First' }, 'v1()');
    await registry.savePlugin({ ...PLUGIN, version: '1.1.0' }, 'v2()');
    await registry.savePlugin({ ...PLUGIN, version: '1.2.0', changelog: '- Third' }, 'v3()');

    const kept = await history.listHistory('plugin', 'demo');
    const { previousVersions, previousChangelogs } = history.keptVersions(kept);
    expect([...previousVersions].sort()).toEqual(['1.0.0', '1.1.0']);
    expect(previousChangelogs).toEqual({ '1.0.0': '- First' });
    expect((await history.readHistoryEntry('plugin', 'demo', '1.0.0')).entry.changelog).toBe('- First');
  });
});

describe('theme history', () => {
  it('keeps css and skin and restores both', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.saveTheme(THEME, 'body{}', ':root{}');
    await registry.saveTheme({ ...THEME, version: '2.0.0' }, 'body{color:red}', null);

    expect((await history.listHistory('theme', 'night')).map((e) => e.version)).toEqual(['1.0.0']);
    const restored = await history.readHistoryEntry('theme', 'night', '1.0.0');
    expect(restored.css).toBe('body{}');
    expect(restored.skin).toBe(':root{}');
  });

  it('forgets the history when the theme is removed', async () => {
    const registry = await import('../plugin-registry');
    const history = await import('../extension-history');
    await registry.saveTheme(THEME, 'body{}', null);
    await registry.saveTheme({ ...THEME, version: '2.0.0' }, 'body{color:red}', null);
    await registry.deleteTheme('night');
    expect(await history.listHistory('theme', 'night')).toEqual([]);
  });
});
