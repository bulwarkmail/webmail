// Reading and validating plugin and theme packages (ZIP + manifest.json).
//
// One implementation for every install path: the browser upload in Settings,
// the admin upload, the marketplace install and the marketplace preview. The
// copies these replace had drifted apart: some checked file types, some the
// permission list, some the origin lists, and none bounded how much a ZIP may
// inflate to.

import { checkCredentials } from './plugin-secrets/credentials';
import JSZip from 'jszip';
import {
  ALL_PERMISSIONS,
  ALLOWED_PLUGIN_FILES,
  DEPRECATED_PERMISSIONS,
  MAX_PLUGIN_SIZE,
  MAX_THEME_SIZE,
  type PluginManifest,
  type PluginTier,
  type PluginType,
  type SettingFieldSchema,
  type ThemeManifest,
  MAX_THEME_SKIN_BYTES,
} from './plugin-types';
import { sanitizeSkinCSS, sanitizeThemeCSS } from './theme-loader';
import { compileAdvancedTheme, isAdvancedManifest } from './theme-compiler';
import { sanitizeApiPostPaths, sanitizeFrameOrigins, sanitizeHttpOrigins } from './extension-origins';

export const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** No real plugin or theme needs more files than this. */
export const MAX_ZIP_ENTRIES = 200;
/** Largest single file we inflate. Bundles are capped at 5 MB zipped. */
export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;

export type ExtensionKind = 'plugin' | 'theme';

export class ExtensionPackageError extends Error {}

export interface OpenedPackage {
  zip: JSZip;
  /** Folder prefix when every entry sits inside one top-level directory. */
  root: string;
}

function toUint8(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Open a package ZIP. Checks the compressed size and entry count; files are
 * only inflated when read (see `readEntry`), each under a hard cap.
 */
export async function openPackage(data: ArrayBuffer | Uint8Array, kind: ExtensionKind): Promise<OpenedPackage> {
  const bytes = toUint8(data);
  const max = kind === 'theme' ? MAX_THEME_SIZE : MAX_PLUGIN_SIZE;
  if (bytes.byteLength > max) {
    throw new ExtensionPackageError(`${kind === 'theme' ? 'Theme' : 'Plugin'} ZIP exceeds ${Math.round(max / (1024 * 1024))} MB size limit`);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ExtensionPackageError('Invalid ZIP file');
  }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new ExtensionPackageError(`ZIP has ${names.length} entries; at most ${MAX_ZIP_ENTRIES} are allowed`);
  }
  return { zip, root: findRoot(zip) };
}

function findRoot(zip: JSZip): string {
  const entries = Object.keys(zip.files);
  const topDirs = new Set(entries.map((e) => e.split('/')[0]));
  if (topDirs.size === 1) {
    const dir = [...topDirs][0];
    if (zip.files[dir + '/'] || entries.some((e) => e.startsWith(dir + '/'))) return dir + '/';
  }
  return '';
}

/**
 * Inflate one entry, stopping as soon as it passes `maxBytes`. The size in
 * the ZIP header is whatever the author wrote, so it can't be trusted to
 * stop a ZIP bomb; counting the inflated bytes can.
 */
export async function readEntry(pkg: OpenedPackage, name: string, maxBytes = MAX_ENTRY_BYTES): Promise<Uint8Array | null> {
  const entry = pkg.zip.file(pkg.root + name);
  if (!entry || entry.dir) return null;
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    // internalStream is part of JSZip's API but missing from its typings.
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): JSZipStream }).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        if (done) return;
        total += chunk.byteLength;
        if (total > maxBytes) {
          done = true;
          stream.pause();
          reject(new ExtensionPackageError(`${name} is larger than ${Math.round(maxBytes / 1024)} KB once unpacked`));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (err: Error) => {
        if (done) return;
        done = true;
        reject(new ExtensionPackageError(`Could not read ${name}: ${err.message}`));
      })
      .on('end', () => {
        if (done) return;
        done = true;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.byteLength;
        }
        resolve(out);
      })
      .resume();
  });
}

interface JSZipStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): JSZipStream;
  on(event: 'error', cb: (err: Error) => void): JSZipStream;
  on(event: 'end', cb: () => void): JSZipStream;
  pause(): JSZipStream;
  resume(): JSZipStream;
}

export async function readText(pkg: OpenedPackage, name: string, maxBytes = MAX_ENTRY_BYTES): Promise<string | null> {
  const bytes = await readEntry(pkg, name, maxBytes);
  return bytes === null ? null : new TextDecoder('utf-8').decode(bytes);
}

export async function readManifest(pkg: OpenedPackage): Promise<Record<string, unknown>> {
  const raw = await readText(pkg, 'manifest.json', MAX_MANIFEST_BYTES);
  if (raw === null) throw new ExtensionPackageError('Missing manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExtensionPackageError('Invalid manifest.json (not valid JSON)');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExtensionPackageError('manifest.json must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Files in a plugin package whose type the host refuses. */
export function disallowedPluginFiles(pkg: OpenedPackage): string[] {
  const out: string[] = [];
  for (const [path, entry] of Object.entries(pkg.zip.files)) {
    if (entry.dir) continue;
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
    if (ext && !ALLOWED_PLUGIN_FILES.has(ext)) out.push(path);
  }
  return out;
}

// ─── Manifest validation ─────────────────────────────────────

export interface ManifestCheck<T> {
  manifest: T | null;
  errors: string[];
  warnings: string[];
}

type InstallablePluginType = Exclude<PluginType, 'theme'>;
const PLUGIN_TYPES: InstallablePluginType[] = ['ui-extension', 'sidebar-app', 'hook'];
const KNOWN_PERMISSIONS = new Set<string>(ALL_PERMISSIONS);

function requireString(m: Record<string, unknown>, key: string, errors: string[], max = 200): string {
  const v = m[key];
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`Missing or invalid "${key}"`);
    return '';
  }
  if (v.length > max) errors.push(`"${key}" is longer than ${max} characters`);
  return v;
}

function optionalString(m: Record<string, unknown>, key: string, errors: string[], max = 2000): string | undefined {
  const v = m[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    errors.push(`"${key}" must be a string`);
    return undefined;
  }
  if (v.length > max) errors.push(`"${key}" is longer than ${max} characters`);
  return v;
}

/** `entrypoint` must name a .js file inside the package. */
function isSafeEntrypoint(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (value.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return /\.(m?js)$/.test(value) && value.length <= 200;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** What an extension version looks like, for callers that take one from a request. */
export const EXTENSION_VERSION_RE = /^(?=.{1,64}$)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Compare dotted versions numerically; pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function validateSettingsSchema(raw: unknown, errors: string[]): Record<string, SettingFieldSchema> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"settingsSchema" must be an object');
    return undefined;
  }
  const out: Record<string, SettingFieldSchema> = {};
  for (const [key, field] of Object.entries(raw as Record<string, unknown>)) {
    const where = `settingsSchema.${key}`;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      errors.push(`${where}: key must be letters, digits and _`);
      continue;
    }
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    const f = field as Record<string, unknown>;
    const type = f.type;
    if (type !== 'boolean' && type !== 'string' && type !== 'number' && type !== 'select') {
      errors.push(`${where}.type must be boolean, string, number or select`);
      continue;
    }
    if (typeof f.label !== 'string' || !f.label) {
      errors.push(`${where}.label is required`);
      continue;
    }
    if (f.description !== undefined && typeof f.description !== 'string') {
      errors.push(`${where}.description must be a string`);
      continue;
    }
    const entry: SettingFieldSchema = { type, label: f.label, default: f.default };
    if (typeof f.description === 'string') entry.description = f.description;
    if (type === 'select') {
      if (!Array.isArray(f.options) || f.options.length === 0 || f.options.some((o) => typeof o !== 'string')) {
        errors.push(`${where}.options must be a non-empty list of strings`);
        continue;
      }
      entry.options = f.options as string[];
      if (!entry.options.includes(f.default as string)) {
        errors.push(`${where}.default must be one of its options`);
        continue;
      }
    } else if (type === 'boolean') {
      if (typeof f.default !== 'boolean') {
        errors.push(`${where}.default must be true or false`);
        continue;
      }
    } else if (type === 'string') {
      if (typeof f.default !== 'string') {
        errors.push(`${where}.default must be a string`);
        continue;
      }
    } else if (type === 'number') {
      for (const bound of ['min', 'max'] as const) {
        if (f[bound] !== undefined && (typeof f[bound] !== 'number' || !Number.isFinite(f[bound]))) {
          errors.push(`${where}.${bound} must be a number`);
        } else if (typeof f[bound] === 'number') {
          entry[bound] = f[bound] as number;
        }
      }
      if (typeof f.default !== 'number' || !Number.isFinite(f.default)) {
        errors.push(`${where}.default must be a number`);
        continue;
      }
      if ((entry.min !== undefined && f.default < entry.min) || (entry.max !== undefined && f.default > entry.max)) {
        errors.push(`${where}.default is outside min/max`);
        continue;
      }
    }
    out[key] = entry;
  }
  return out;
}

const CONFIG_FIELD_TYPES = new Set(['string', 'secret', 'boolean', 'number', 'select']);

/** Admin-level setting a plugin declares (`configSchema`); mirrors PluginConfigField. */
export interface ConfigFieldSchema {
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: { label: string; value: string }[];
  /** `type: 'string'` only: the admin form shows a full-width text box. */
  multiline?: boolean;
}

function validateConfigSchema(raw: unknown, errors: string[]): Record<string, ConfigFieldSchema> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"configSchema" must be an object');
    return undefined;
  }
  const out: Record<string, ConfigFieldSchema> = {};
  for (const [key, field] of Object.entries(raw as Record<string, unknown>)) {
    const where = `configSchema.${key}`;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      errors.push(`${where}: key must be letters, digits and _`);
      continue;
    }
    const f = field as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || Array.isArray(f) || !CONFIG_FIELD_TYPES.has(f.type as string) || typeof f.label !== 'string') {
      errors.push(`${where} needs a type (string, secret, boolean, number, select) and a label`);
      continue;
    }
    if (f.type === 'select' && (!Array.isArray(f.options) || f.options.some((o) => !o || typeof (o as { value?: unknown }).value !== 'string'))) {
      errors.push(`${where}.options must be a list of { label, value }`);
      continue;
    }
    out[key] = f as unknown as ConfigFieldSchema;
  }
  return out;
}

const MAX_LOCALES = 64;
const MAX_LOCALE_KEYS = 2000;

function validateLocales(raw: unknown, errors: string[]): Record<string, Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"locales" must be an object of locale → { key: text }');
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_LOCALES) {
    errors.push(`"locales" has more than ${MAX_LOCALES} languages`);
    return undefined;
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [locale, table] of entries) {
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
      errors.push(`locales: "${locale}" is not a language tag`);
      continue;
    }
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      errors.push(`locales.${locale} must be an object`);
      continue;
    }
    const strings = Object.entries(table as Record<string, unknown>);
    if (strings.length > MAX_LOCALE_KEYS || strings.some(([, v]) => typeof v !== 'string')) {
      errors.push(`locales.${locale} must map at most ${MAX_LOCALE_KEYS} keys to strings`);
      continue;
    }
    out[locale] = table as Record<string, string>;
  }
  return out;
}

function originList(
  m: Record<string, unknown>,
  key: 'frameOrigins' | 'httpOrigins' | 'apiPostPaths',
  sanitize: (v: unknown) => string[],
  errors: string[],
  warnings: string[],
): string[] | undefined {
  const raw = m[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`"${key}" must be a list`);
    return undefined;
  }
  const kept = sanitize(raw);
  const dropped = raw.filter((v) => typeof v !== 'string' || !kept.includes(v));
  if (dropped.length > 0) warnings.push(`Ignored invalid ${key}: ${dropped.map(String).join(', ')}`);
  return kept.length > 0 ? kept : undefined;
}

/** What every install path stores for a plugin, after validation. */
export type ValidatedPluginManifest = PluginManifest & {
  frameOrigins?: string[];
  configSchema?: Record<string, ConfigFieldSchema>;
};

/**
 * Validate a plugin manifest. Returns a copy holding only known, checked
 * fields, so nothing the host didn't validate is ever stored.
 */
export function checkPluginManifest(m: Record<string, unknown>, opts: { appVersion?: string } = {}): ManifestCheck<ValidatedPluginManifest> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const id = requireString(m, 'id', errors, 64);
  if (id && !EXTENSION_ID_RE.test(id)) errors.push('ID must be lowercase alphanumeric with hyphens, min 2 chars');
  const name = requireString(m, 'name', errors, 100);
  const version = requireString(m, 'version', errors, 64);
  if (version && !VERSION_RE.test(version)) errors.push('"version" must look like 1.2.3');
  const author = requireString(m, 'author', errors, 200);
  const description = optionalString(m, 'description', errors) ?? '';

  const type = m.type as InstallablePluginType;
  if (!PLUGIN_TYPES.includes(type)) errors.push(`Invalid type "${String(m.type)}". Must be one of: ${PLUGIN_TYPES.join(', ')}`);

  let tier: PluginTier | undefined;
  if (m.tier !== undefined) {
    if (m.tier !== 'untrusted' && m.tier !== 'privileged') errors.push('"tier" must be "untrusted" or "privileged"');
    else tier = m.tier;
  }

  const entrypoint = typeof m.entrypoint === 'string' && m.entrypoint ? m.entrypoint : 'index.js';
  if (!isSafeEntrypoint(entrypoint)) errors.push('"entrypoint" must be a .js file inside the package');

  // A string here used to slip past every check and then match by substring
  // ("crypto:full email:send" granted both).
  let permissions: string[] = [];
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== 'string')) {
      errors.push('"permissions" must be a list of strings');
    } else {
      permissions = [...new Set(m.permissions as string[])];
      const deprecated = permissions.filter((p) => DEPRECATED_PERMISSIONS.includes(p));
      if (deprecated.length > 0) {
        warnings.push(`Ignored permissions that no longer grant anything: ${deprecated.join(', ')}`);
        permissions = permissions.filter((p) => !DEPRECATED_PERMISSIONS.includes(p));
      }
      const unknown = permissions.filter((p) => !KNOWN_PERMISSIONS.has(p));
      if (unknown.length > 0) errors.push(`Unknown permissions: ${unknown.join(', ')} (this Bulwark version does not offer them)`);
    }
  }
  // Permissions a plugin uses when the webmail offers them: the ones this
  // version knows are granted like "permissions" (and shown for consent the
  // same way); unknown ones are left out, so one package installs on older
  // and newer webmails alike and checks api.host.features for what it got.
  if (m.optionalPermissions !== undefined) {
    if (!Array.isArray(m.optionalPermissions) || m.optionalPermissions.some((p) => typeof p !== 'string')) {
      errors.push('"optionalPermissions" must be a list of strings');
    } else {
      const asked = [...new Set(m.optionalPermissions as string[])].filter((p) => !DEPRECATED_PERMISSIONS.includes(p));
      const unknown = asked.filter((p) => !KNOWN_PERMISSIONS.has(p));
      if (unknown.length > 0) warnings.push(`Left out optional permissions this Bulwark version does not offer: ${unknown.join(', ')}`);
      permissions = [...new Set([...permissions, ...asked.filter((p) => KNOWN_PERMISSIONS.has(p))])];
    }
  }
  // Only the privileged tier may reach the OS certificate store. Left out rather than
  // refused, like an optional permission this version doesn't offer: the host would
  // refuse the calls anyway, and consent shouldn't ask for what can't be used.
  if (tier !== 'privileged' && permissions.includes('keystore')) {
    warnings.push('Left out the "keystore" permission: it needs the privileged tier');
    permissions = permissions.filter((p) => p !== 'keystore');
  }
  if (tier === 'privileged' && !permissions.includes('crypto:full')) {
    errors.push('A privileged plugin must request the "crypto:full" permission');
  }

  const minAppVersion = optionalString(m, 'minAppVersion', errors, 32);
  if (minAppVersion !== undefined && !VERSION_RE.test(minAppVersion)) errors.push('"minAppVersion" must look like 1.2.3');
  if (minAppVersion && opts.appVersion && VERSION_RE.test(opts.appVersion) && compareVersions(opts.appVersion, minAppVersion) < 0) {
    errors.push(`Needs Bulwark ${minAppVersion} or later (this is ${opts.appVersion})`);
  }

  const settingsSchema = validateSettingsSchema(m.settingsSchema, errors);
  const configSchema = validateConfigSchema(m.configSchema, errors);
  const locales = validateLocales(m.locales, errors);
  const frameOrigins = originList(m, 'frameOrigins', sanitizeFrameOrigins, errors, warnings);
  const httpOrigins = originList(m, 'httpOrigins', sanitizeHttpOrigins, errors, warnings);
  const apiPostPaths = originList(m, 'apiPostPaths', sanitizeApiPostPaths, errors, warnings);
  const credentialCheck = checkCredentials(m.credentials, configSchema);
  errors.push(...credentialCheck.errors);

  if (errors.length > 0) return { manifest: null, errors, warnings };

  const manifest: ValidatedPluginManifest = {
    id, name, version, author, description, type, permissions, entrypoint,
    ...(tier ? { tier } : {}),
    ...(minAppVersion ? { minAppVersion } : {}),
    ...(settingsSchema && Object.keys(settingsSchema).length ? { settingsSchema } : {}),
    ...(configSchema && Object.keys(configSchema).length ? { configSchema } : {}),
    ...(locales && Object.keys(locales).length ? { locales } : {}),
    ...(frameOrigins ? { frameOrigins } : {}),
    ...(httpOrigins ? { httpOrigins } : {}),
    ...(apiPostPaths ? { apiPostPaths } : {}),
    ...(credentialCheck.credentials && Object.keys(credentialCheck.credentials).length ? { credentials: credentialCheck.credentials } : {}),
  };
  return { manifest, errors, warnings };
}

// ─── Plugin code checks ──────────────────────────────────────

const SUSPICIOUS_JS_PATTERNS = [
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'new Function()' },
  { pattern: /document\.cookie/, label: 'document.cookie' },
  { pattern: /document\.write/, label: 'document.write' },
  { pattern: /innerHTML\s*=/, label: 'innerHTML assignment' },
];

/** Patterns worth a reviewer's second look. Not a security boundary: the sandbox is. */
export function suspiciousCode(code: string): string[] {
  return SUSPICIOUS_JS_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(({ label }) => label);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 over the validated manifest and the code. An admin approval is
 * pinned to this, so re-zipping the same code with more permissions or
 * other origins needs a new approval. Same result in the browser and on
 * the server.
 */
export async function packageHash(manifest: ValidatedPluginManifest, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${canonicalJson(manifest)}\n${code}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PluginPackage {
  manifest: ValidatedPluginManifest;
  code: string;
  warnings: string[];
  /** The opened ZIP, for callers that read more files (preview image). */
  pkg: OpenedPackage;
}

/**
 * Open, validate and read a plugin package. Throws ExtensionPackageError
 * with every problem found when it is not installable.
 */
export async function readPluginPackage(
  data: ArrayBuffer | Uint8Array,
  opts: { appVersion?: string; expectedId?: string } = {},
): Promise<PluginPackage> {
  const pkg = await openPackage(data, 'plugin');
  const raw = await readManifest(pkg);
  const check = checkPluginManifest(raw, opts);
  const errors = [...check.errors];
  const bad = disallowedPluginFiles(pkg);
  if (bad.length > 0) errors.push(`Disallowed file types: ${bad.join(', ')}`);
  if (check.manifest && opts.expectedId !== undefined && check.manifest.id !== opts.expectedId) {
    errors.push(`Package id "${check.manifest.id}" does not match "${opts.expectedId}"`);
  }
  if (errors.length > 0 || !check.manifest) throw new ExtensionPackageError(errors.join('; '));
  const code = await readText(pkg, check.manifest.entrypoint);
  if (code === null) throw new ExtensionPackageError(`Missing entrypoint file: ${check.manifest.entrypoint}`);
  const warnings = [...check.warnings, ...suspiciousCode(code).map((l) => `Contains ${l} - review for security`)];
  return { manifest: check.manifest, code, warnings, pkg };
}

// ─── Themes ──────────────────────────────────────────────────

function validateBaseManifest(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (!manifest.id || typeof manifest.id !== 'string') errors.push('Missing or invalid "id"');
  if (!manifest.name || typeof manifest.name !== 'string') errors.push('Missing or invalid "name"');
  if (!manifest.version || typeof manifest.version !== 'string') errors.push('Missing or invalid "version"');
  if (!manifest.author || typeof manifest.author !== 'string') errors.push('Missing or invalid "author"');
  if (!manifest.type || typeof manifest.type !== 'string') errors.push('Missing or invalid "type"');

  // Validate ID format (alphanumeric + hyphens)
  if (manifest.id && typeof manifest.id === 'string' && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(manifest.id)) {
    errors.push('ID must be lowercase alphanumeric with hyphens, min 2 chars');
  }

  return errors;
}

export function checkThemeManifest(manifest: Record<string, unknown>): { result: ThemeManifest | null; errors: string[] } {
  const errors = validateBaseManifest(manifest);

  if (manifest.type !== 'theme') {
    errors.push(`Expected type "theme", got "${manifest.type}"`);
  }

  if (!manifest.variants || !Array.isArray(manifest.variants) || manifest.variants.length === 0) {
    errors.push('Missing or empty "variants" array (must be ["light"], ["dark"], or ["light","dark"])');
  } else {
    const valid = manifest.variants.every((v: unknown) => v === 'light' || v === 'dark');
    if (!valid) errors.push('Variants must be "light" or "dark"');
  }

  // ── Theme API v2 fields (all optional) ──
  if (manifest.apiVersion !== undefined && manifest.apiVersion !== 1 && manifest.apiVersion !== 2) {
    errors.push('"apiVersion" must be 1 or 2 if present');
  }
  if (manifest.extends !== undefined && typeof manifest.extends !== 'string') {
    errors.push('"extends" must be a string (the parent theme id)');
  }
  if (manifest.tokens !== undefined && (typeof manifest.tokens !== 'object' || manifest.tokens === null)) {
    errors.push('"tokens" must be an object with optional "common"/"light"/"dark" maps');
  }
  if (manifest.density !== undefined && !['compact', 'normal', 'touch'].includes(manifest.density as string)) {
    errors.push('"density" must be "compact", "normal", or "touch"');
  }
  if (manifest.derive !== undefined && typeof manifest.derive !== 'boolean') {
    errors.push('"derive" must be a boolean');
  }
  if (manifest.radii !== undefined && (typeof manifest.radii !== 'object' || manifest.radii === null)) {
    errors.push('"radii" must be an object');
  }
  if (manifest.typography !== undefined && (typeof manifest.typography !== 'object' || manifest.typography === null)) {
    errors.push('"typography" must be an object');
  }

  if (errors.length > 0) return { result: null, errors };

  return {
    result: manifest as unknown as ThemeManifest,
    errors: [],
  };
}

export interface ThemePackageResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: ThemeManifest | null;
  /** Compiled (Theme API v2) and sanitized CSS. */
  css: string;
  /** Sanitized skin.css for v2 themes, else null. */
  skin: string | null;
  pkg: OpenedPackage | null;
}

/**
 * Open, validate and compile a theme package. v1 themes need theme.css; v2
 * themes may be tokens only and may ship a skin.css. `resolveExtends` returns
 * the CSS of an installed theme for `extends`.
 */
export async function readThemePackage(
  data: ArrayBuffer | Uint8Array,
  opts: { resolveExtends?: (id: string) => string | null } = {},
): Promise<ThemePackageResult> {
  const fail = (errors: string[], warnings: string[] = [], manifest: ThemeManifest | null = null, pkg: OpenedPackage | null = null): ThemePackageResult =>
    ({ valid: false, errors, warnings, manifest, css: '', skin: null, pkg });
  const errors: string[] = [];
  const warnings: string[] = [];

  let pkg: OpenedPackage;
  let manifestData: Record<string, unknown>;
  try {
    pkg = await openPackage(data, 'theme');
    manifestData = await readManifest(pkg);
  } catch (err) {
    return fail([err instanceof ExtensionPackageError ? err.message : 'Invalid ZIP file']);
  }

  const { result: manifest, errors: manifestErrors } = checkThemeManifest(manifestData);
  if (!manifest) return fail(manifestErrors, warnings, null, pkg);

  // theme.css is required for v1 themes, optional for v2 ones, whose CSS the
  // compiler can produce from the manifest alone.
  const isAdvanced = isAdvancedManifest(manifest);
  let cssText: string | null;
  let skinText: string | null;
  try {
    cssText = await readText(pkg, 'theme.css');
    skinText = await readText(pkg, 'skin.css', MAX_THEME_SKIN_BYTES * 4);
  } catch (err) {
    return fail([err instanceof ExtensionPackageError ? err.message : 'Could not read theme files'], warnings, manifest, pkg);
  }

  let userCSS = '';
  if (cssText !== null) {
    // Sanitize instead of rejecting, and always: the sanitizer is also what
    // drops rules outside :root and .dark.
    const sanitized = sanitizeThemeCSS(cssText);
    userCSS = sanitized.css;
    warnings.push(...sanitized.warnings);
  } else if (!isAdvanced) {
    return fail(['Missing theme.css'], warnings, manifest, pkg);
  }

  let css = userCSS;
  if (isAdvanced) {
    const compiled = compileAdvancedTheme(manifest, { userCSS, resolveExtends: opts.resolveExtends });
    if (compiled.errors.length > 0) return fail([...errors, ...compiled.errors], warnings, manifest, pkg);
    warnings.push(...compiled.warnings);
    // Defence in depth: sanitize the compiled output too.
    const sanitized = sanitizeThemeCSS(compiled.css);
    css = sanitized.css;
    warnings.push(...sanitized.warnings);
  }

  // Skins target real component selectors and skip the :root/.dark selector
  // check; they still go through the dangerous-pattern sanitizer.
  let skin: string | null = null;
  if (skinText !== null) {
    if (!isAdvanced) {
      warnings.push('skin.css ignored - only Theme API v2 manifests can ship a skin');
    } else if (skinText.length > MAX_THEME_SKIN_BYTES) {
      warnings.push(`skin.css exceeds ${Math.round(MAX_THEME_SKIN_BYTES / 1024)} KB and was dropped`);
    } else {
      const sanitized = sanitizeSkinCSS(skinText);
      skin = sanitized.css;
      warnings.push(...sanitized.warnings);
    }
  }

  return { valid: true, errors: [], warnings, manifest, css, skin, pkg };
}
