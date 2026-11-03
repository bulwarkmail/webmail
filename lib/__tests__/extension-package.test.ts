import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  checkPluginManifest,
  compareVersions,
  readPluginPackage,
  MAX_ENTRY_BYTES,
  MAX_ZIP_ENTRIES,
} from '../extension-package';

const BASE = {
  id: 'demo-plugin', name: 'Demo', version: '1.0.0', author: 'me', description: 'd',
  type: 'hook', permissions: ['email:read'], entrypoint: 'index.js',
};

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('checkPluginManifest', () => {
  it('accepts a normal manifest and keeps only checked fields', () => {
    const { manifest, errors } = checkPluginManifest({ ...BASE, somethingElse: 1, locales: { de: { a: 'b' } } });

    expect(errors).toEqual([]);
    expect(manifest).toMatchObject({ id: 'demo-plugin', permissions: ['email:read'], locales: { de: { a: 'b' } } });
    expect(manifest).not.toHaveProperty('somethingElse');
  });

  it('refuses permissions given as a string', () => {
    // As a string, "crypto:full email:send" used to pass validation and then
    // grant both through String.prototype.includes.
    const { manifest, errors } = checkPluginManifest({ ...BASE, permissions: 'crypto:full email:send' });

    expect(manifest).toBeNull();
    expect(errors.join()).toMatch(/must be a list of strings/);
  });

  it('refuses unknown permissions', () => {
    expect(checkPluginManifest({ ...BASE, permissions: ['email:read', 'root:all'] }).errors.join())
      .toMatch(/Unknown permissions: root:all/);
  });

  it('grants the optional permissions it knows and leaves out the others, with a warning', () => {
    const { manifest, errors, warnings } = checkPluginManifest({ ...BASE, optionalPermissions: ['files:read', 'settings:fly', 'email:read'] });

    expect(errors).toEqual([]);
    expect(manifest!.permissions).toEqual(['email:read', 'files:read']);
    expect(warnings.join()).toMatch(/Left out optional permissions .*settings:fly/);
    expect(manifest).not.toHaveProperty('optionalPermissions');
  });

  it('refuses optional permissions given as a string', () => {
    expect(checkPluginManifest({ ...BASE, optionalPermissions: 'files:read' }).errors.join()).toMatch(/"optionalPermissions" must be a list of strings/);
  });

  it.each(['../index.js', '/index.js', 'a/../../x.js', 'index.css', 'a\\b.js'])('refuses entrypoint %s', (entrypoint) => {
    expect(checkPluginManifest({ ...BASE, entrypoint }).manifest).toBeNull();
  });

  it('refuses a select setting whose options are not a list', () => {
    const { errors } = checkPluginManifest({
      ...BASE,
      settingsSchema: { mode: { type: 'select', label: 'Mode', default: 'a', options: 'a,b' } },
    });

    expect(errors.join()).toMatch(/settingsSchema\.mode\.options/);
  });

  it('refuses a number default outside min/max', () => {
    const { errors } = checkPluginManifest({
      ...BASE,
      settingsSchema: { size: { type: 'number', label: 'Size', default: 900, min: 16, max: 512 } },
    });

    expect(errors.join()).toMatch(/outside min\/max/);
  });

  it('drops invalid origins with a warning instead of storing them', () => {
    const { manifest, warnings } = checkPluginManifest({
      ...BASE,
      permissions: ['http:fetch'],
      httpOrigins: ['https://api.example.com', 'https://*.com', 'http://plain.example'],
    });

    expect(manifest?.httpOrigins).toEqual(['https://api.example.com']);
    expect(warnings.join()).toMatch(/\*\.com/);
  });

  it('refuses a plugin that needs a newer Bulwark', () => {
    expect(checkPluginManifest({ ...BASE, minAppVersion: '9.0.0' }, { appVersion: '1.9.2' }).errors.join())
      .toMatch(/Needs Bulwark 9\.0\.0/);
  });

  it('refuses a privileged plugin without crypto:full', () => {
    expect(checkPluginManifest({ ...BASE, tier: 'privileged' }).manifest).toBeNull();
  });
});

describe('readPluginPackage', () => {
  it('reads manifest and code from a package in a sub folder', async () => {
    const data = await zipOf({ 'demo/manifest.json': JSON.stringify(BASE), 'demo/index.js': 'module.exports = {}' });

    const pkg = await readPluginPackage(data);

    expect(pkg.code).toBe('module.exports = {}');
    expect(pkg.manifest.id).toBe('demo-plugin');
  });

  it('stops inflating a file that unpacks past the limit (ZIP bomb)', async () => {
    // ~25 KB compressed, more than the per-file cap once inflated.
    const data = await zipOf({
      'manifest.json': JSON.stringify(BASE),
      'index.js': new Uint8Array(MAX_ENTRY_BYTES + 1024),
    });
    expect(data.byteLength).toBeLessThan(200 * 1024);

    await expect(readPluginPackage(data)).rejects.toThrow(/larger than .* once unpacked/);
  });

  it('refuses a ZIP with too many entries', async () => {
    const files: Record<string, string> = { 'manifest.json': JSON.stringify(BASE), 'index.js': '' };
    for (let i = 0; i < MAX_ZIP_ENTRIES; i++) files[`f${i}.json`] = '{}';

    await expect(readPluginPackage(await zipOf(files))).rejects.toThrow(/entries/);
  });

  it('refuses disallowed file types', async () => {
    const data = await zipOf({ 'manifest.json': JSON.stringify(BASE), 'index.js': '', 'run.exe': 'MZ' });

    await expect(readPluginPackage(data)).rejects.toThrow(/run\.exe/);
  });

  it('refuses a package whose id is not the expected one', async () => {
    const data = await zipOf({ 'manifest.json': JSON.stringify(BASE), 'index.js': '' });

    await expect(readPluginPackage(data, { expectedId: 'other' })).rejects.toThrow(/does not match/);
  });
});

describe('compareVersions', () => {
  it('compares numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.0', '1.2.0-beta.1')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
  });
});

describe('deprecated permissions', () => {
  it('drops smime:read with a warning instead of refusing the plugin', () => {
    const { manifest, warnings } = checkPluginManifest({ ...BASE, permissions: ['email:read', 'smime:read'] });

    expect(manifest?.permissions).toEqual(['email:read']);
    expect(warnings.join()).toMatch(/smime:read/);
  });
});
