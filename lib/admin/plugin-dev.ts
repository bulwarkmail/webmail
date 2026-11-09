import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { logger } from '@/lib/logger';
import type { ServerPlugin } from './plugin-registry';
import { checkPluginManifest } from '@/lib/extension-package';

/**
 * Dev-mode plugin loading.
 *
 * Set PLUGIN_DEV_DIR to a directory whose immediate subfolders are plugin
 * sources. Each subfolder must contain a `manifest.json`. The bundle file
 * (declared as `entrypoint` in the manifest) is resolved in this order:
 *
 *   1. `src/<entrypoint>`  → bundled on-demand via esbuild (preferred).
 *      Lets you edit source files directly and just refresh the browser.
 *   2. `<entrypoint>` at the plugin root → served raw.
 *   3. `dist/<entrypoint>` → served raw (output of a manual build).
 *
 * Bundles are recomputed on every request so any save in `src/` propagates
 * to all connected clients on their next page refresh. The content hash
 * doubles as the HTTP ETag and the `?v=` cache-buster.
 */

export interface DevPluginEntry {
  plugin: ServerPlugin;
  /** Absolute path to either a source file (needs bundling) or a built file. */
  bundlePath: string;
  manifestPath: string;
  /** True when bundlePath points at an unbundled source file under `src/`. */
  needsBundle: boolean;
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function getPluginDevDir(): string | null {
  const dir = process.env.PLUGIN_DEV_DIR;
  if (!dir) return null;
  const resolved = path.resolve(dir);
  if (!existsSync(resolved)) {
    logger.warn(`PLUGIN_DEV_DIR is set but does not exist: ${resolved}`);
    return null;
  }
  return resolved;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

async function readManifest(manifestPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

interface ResolvedBundle {
  bundlePath: string;
  needsBundle: boolean;
}

/** Whether `candidate` lies inside `dir` (after resolving `..`). */
function isInside(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveBundlePath(pluginDir: string, entrypoint: string): ResolvedBundle | null {
  // The bundle route serves this file to anyone, so it must stay inside the
  // plugin's own folder whatever the manifest says.
  const candidates: Array<[string, boolean]> = [
    [path.join(pluginDir, 'src', entrypoint), true],
    [path.join(pluginDir, entrypoint), false],
    [path.join(pluginDir, 'dist', entrypoint), false],
  ];
  for (const [candidate, needsBundle] of candidates) {
    if (isInside(pluginDir, candidate) && existsSync(candidate)) return { bundlePath: candidate, needsBundle };
  }
  return null;
}

async function bundleEntrypoint(bundlePath: string): Promise<string> {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [bundlePath],
    bundle: true,
    // CJS format matches the sandbox runtime's evaluator
    // (`new Function('module', 'exports', 'require', 'React', ...)`).
    format: 'cjs',
    platform: 'neutral',
    // Neutral leaves mainFields empty, so packages that only declare "main"
    // or "module" (asn1js, pkijs, ...) would not resolve.
    mainFields: ['browser', 'module', 'main'],
    write: false,
    logLevel: 'silent',
    sourcemap: 'inline',
    target: ['es2020'],
    // The runtime's `require` shim resolves these at evaluation time:
    //   react / react-dom / react-dom/client / react/jsx-runtime → host copies
    //   @plugin-host → the per-plugin `api` object
    external: [
      'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime',
      '@plugin-host',
      // Browser libraries reach for Node builtins behind runtime checks that
      // never pass in the sandbox (asmcrypto's require('crypto')). Leave them
      // out instead of failing the whole bundle.
      ...builtinModules, ...builtinModules.map((m) => `node:${m}`),
    ],
  });
  const out = result.outputFiles?.[0]?.text;
  if (!out) throw new Error('esbuild produced no output');
  return out;
}

/**
 * Load and bundle a dev plugin's code. For `src/` sources this runs esbuild
 * on every call so saves are reflected immediately. Errors are surfaced as
 * a JS module that throws at activation time - that way the dev sees the
 * failure in the browser console instead of a silent 404.
 */
export async function readDevBundle(entry: DevPluginEntry): Promise<string> {
  if (!entry.needsBundle) {
    return readFile(entry.bundlePath, 'utf-8');
  }
  try {
    return await bundleEntrypoint(entry.bundlePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[plugin-dev] esbuild failed for ${entry.plugin.id}`, { error: message });
    // Return a module that throws on load so the dev sees the error.
    return `throw new Error(${JSON.stringify(`[plugin-dev:${entry.plugin.id}] esbuild failed: ${message}`)});`;
  }
}

async function loadDevPlugin(pluginDir: string): Promise<DevPluginEntry | null> {
  // Prefer the root manifest.json. Fall back to dist/manifest.json for
  // pre-built plugins that don't keep a manifest at the root.
  let manifestPath = path.join(pluginDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    manifestPath = path.join(pluginDir, 'dist', 'manifest.json');
  }
  if (!existsSync(manifestPath)) {
    logger.warn(`[plugin-dev] no manifest.json at root or dist/ in ${pluginDir}`);
    return null;
  }

  const manifest = await readManifest(manifestPath);
  if (!manifest) {
    logger.warn(`[plugin-dev] manifest unreadable or not a JSON object: ${manifestPath}`);
    return null;
  }
  const id = asString(manifest.id);
  if (!PLUGIN_ID_RE.test(id)) {
    logger.warn(`[plugin-dev] manifest id "${id}" rejected by id regex (${manifestPath})`);
    return null;
  }
  // Same checks as an upload, with the fields a work-in-progress manifest
  // may leave out filled in.
  const check = checkPluginManifest({
    version: '0.0.0',
    author: 'dev',
    type: 'hook',
    ...manifest,
    name: asString(manifest.name, id) || id,
  });
  if (!check.manifest) {
    logger.warn(`[plugin-dev] ${id}: ${check.errors.join('; ')}`);
    return null;
  }
  const valid = check.manifest;

  const entrypoint = valid.entrypoint;
  const resolved = resolveBundlePath(pluginDir, entrypoint);
  if (!resolved) {
    logger.warn(`[plugin-dev] entrypoint "${entrypoint}" not found at src/, root, or dist/ for ${id}`);
    return null;
  }

  // Hash from the exact bytes the bundle endpoint will serve so the client's
  // verifyBundle check passes. For src/ sources that means running esbuild
  // here too - slightly more work per manifest list, but unavoidable since
  // the source hash wouldn't match the served bundle.
  let bundleHash: string;
  try {
    const bytes = resolved.needsBundle
      ? await bundleEntrypoint(resolved.bundlePath)
      : await readFile(resolved.bundlePath);
    bundleHash = createHash('sha256').update(bytes).digest('hex');
  } catch (err) {
    logger.warn(`[plugin-dev] failed to hash bundle at ${resolved.bundlePath} for ${id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let installedAt = new Date().toISOString();
  try {
    const stats = await stat(resolved.bundlePath);
    installedAt = stats.mtime.toISOString();
  } catch {
    /* ignore */
  }

  const plugin: ServerPlugin = {
    id,
    name: valid.name,
    version: valid.version,
    author: valid.author,
    description: valid.description,
    type: valid.type,
    ...(valid.tier === 'privileged' ? { tier: 'privileged' } : {}),
    permissions: valid.permissions,
    entrypoint,
    enabled: true,
    forceEnabled: false,
    ...(valid.configSchema ? { configSchema: valid.configSchema } : {}),
    ...(valid.settingsSchema ? { settingsSchema: valid.settingsSchema } : {}),
    ...(valid.locales ? { locales: valid.locales } : {}),
    ...(valid.frameOrigins ? { frameOrigins: valid.frameOrigins } : {}),
    ...(valid.httpOrigins ? { httpOrigins: valid.httpOrigins } : {}),
    ...(valid.credentials ? { credentials: valid.credentials } : {}),
    ...(valid.apiPostPaths ? { apiPostPaths: valid.apiPostPaths } : {}),
    installedAt,
    updatedAt: new Date().toISOString(),
    bundleHash,
  };
  return { plugin, bundlePath: resolved.bundlePath, manifestPath, needsBundle: resolved.needsBundle };
}

export async function listDevPlugins(): Promise<DevPluginEntry[]> {
  const dir = getPluginDevDir();
  if (!dir) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    logger.warn('Failed to read PLUGIN_DEV_DIR', {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const out: DevPluginEntry[] = [];
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const fullPath = path.join(dir, name);
    let isDir = false;
    try { isDir = (await stat(fullPath)).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    const entry = await loadDevPlugin(fullPath);
    if (entry) out.push(entry);
  }
  return out;
}

export async function getDevPlugin(id: string): Promise<DevPluginEntry | null> {
  if (!PLUGIN_ID_RE.test(id)) return null;
  const list = await listDevPlugins();
  return list.find(e => e.plugin.id === id) ?? null;
}
