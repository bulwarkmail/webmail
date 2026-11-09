// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;

async function devPlugin(folder: string, manifest: Record<string, unknown>, files: Record<string, string> = { 'index.js': 'module.exports = {}' }) {
  const p = path.join(dir, 'plugins', folder);
  await mkdir(p, { recursive: true });
  await writeFile(path.join(p, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(p, name)), { recursive: true });
    await writeFile(path.join(p, name), body);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-plugin-dev-'));
  await mkdir(path.join(dir, 'config'), { recursive: true });
  vi.stubEnv('PLUGIN_DEV_DIR', path.join(dir, 'plugins'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const BASE = { name: 'Dev', version: '1.0.0', author: 'me', type: 'ui-extension', entrypoint: 'index.js' };

describe('dev plugins', () => {
  it('keeps locales, tier and frame origins', async () => {
    await devPlugin('demo', {
      ...BASE, id: 'demo', permissions: ['crypto:full'], tier: 'privileged',
      locales: { de: { hi: 'Hallo' } }, frameOrigins: ['https://video.example.com'],
    });
    const { listDevPlugins } = await import('../plugin-dev');
    const { getEnabledPluginFrameOrigins } = await import('../csp-frame-origins');

    const [entry] = await listDevPlugins();

    expect(entry.plugin.locales).toEqual({ de: { hi: 'Hallo' } });
    expect(entry.plugin.tier).toBe('privileged');
    expect(await getEnabledPluginFrameOrigins()).toContain('https://video.example.com');
  });

  it('bundles src/ with packages that only declare main and touch Node builtins', async () => {
    // Shaped like asn1js (no "exports") and asmcrypto (require('crypto')
    // behind a runtime check), which the S/MIME plugin pulls in.
    await devPlugin('deps', { ...BASE, id: 'deps' }, {
      'src/index.js': "import { value } from 'legacy-pkg';\nexport default value;",
      'node_modules/legacy-pkg/package.json': JSON.stringify({ name: 'legacy-pkg', main: 'lib/main.js' }),
      'node_modules/legacy-pkg/lib/main.js':
        "exports.value = typeof process !== 'undefined' && process.versions?.node ? require('crypto') : 42;",
    });
    const { listDevPlugins, readDevBundle } = await import('../plugin-dev');

    const [entry] = await listDevPlugins();

    expect(entry?.plugin.id).toBe('deps');
    expect(await readDevBundle(entry)).not.toContain('esbuild failed');
  });

  it('refuses an entrypoint outside the plugin folder', async () => {
    // The bundle route serves the file without a session.
    await writeFile(path.join(dir, 'secret.js'), 'TOP SECRET');
    await devPlugin('escape', { ...BASE, id: 'escape', entrypoint: '../../secret.js' });
    const { listDevPlugins } = await import('../plugin-dev');

    expect(await listDevPlugins()).toEqual([]);
  });
});
