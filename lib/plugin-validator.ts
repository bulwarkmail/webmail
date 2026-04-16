// Plugin/Theme ZIP upload validation, extraction, and manifest parsing

import JSZip from 'jszip';
import {
  type ThemeManifest,
  type PluginManifest,
  type PluginType,
  ALL_PERMISSIONS,
  MAX_PLUGIN_SIZE,
  MAX_THEME_SIZE,
  ALLOWED_PLUGIN_FILES,
} from './plugin-types';
import { sanitizeThemeCSS, validateThemeCSSSafety } from './theme-loader';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ThemeExtractionResult extends ValidationResult {
  manifest: ThemeManifest | null;
  css: string;
  preview: string | null; // data URI
}

export interface PluginExtractionResult extends ValidationResult {
  manifest: PluginManifest | null;
  code: string;
  preview: string | null;
}

// ─── Manifest Validation ─────────────────────────────────────

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

function validateThemeManifest(manifest: Record<string, unknown>): { result: ThemeManifest | null; errors: string[] } {
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

  if (errors.length > 0) return { result: null, errors };

  return {
    result: manifest as unknown as ThemeManifest,
    errors: [],
  };
}

function validatePluginManifest(manifest: Record<string, unknown>): { result: PluginManifest | null; errors: string[] } {
  const errors = validateBaseManifest(manifest);

  const validTypes: PluginType[] = ['ui-extension', 'sidebar-app', 'hook'];
  if (!validTypes.includes(manifest.type as PluginType)) {
    errors.push(`Invalid type "${manifest.type}". Must be one of: ${validTypes.join(', ')}`);
  }

  if (!manifest.entrypoint || typeof manifest.entrypoint !== 'string') {
    errors.push('Missing or invalid "entrypoint"');
  }

  if (manifest.permissions && Array.isArray(manifest.permissions)) {
    const validPerms = new Set(ALL_PERMISSIONS as readonly string[]);
    const unknown = (manifest.permissions as string[]).filter(p => !validPerms.has(p));
    if (unknown.length > 0) {
      errors.push(`Unknown permissions: ${unknown.join(', ')}`);
    }
  }

  if (errors.length > 0) return { result: null, errors };

  return {
    result: {
      ...(manifest as unknown as PluginManifest),
      permissions: (manifest.permissions as string[]) || [],
    },
    errors: [],
  };
}

// ─── JS Security Checks ─────────────────────────────────────

const SUSPICIOUS_JS_PATTERNS = [
  { pattern: /\beval\s*\(/g, label: 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/g, label: 'new Function()' },
  { pattern: /document\.cookie/g, label: 'document.cookie' },
  { pattern: /document\.write/g, label: 'document.write' },
  { pattern: /innerHTML\s*=/g, label: 'innerHTML assignment' },
];

function checkJSSecurity(code: string): string[] {
  const warnings: string[] = [];
  for (const { pattern, label } of SUSPICIOUS_JS_PATTERNS) {
    if (pattern.test(code)) {
      warnings.push(`Contains ${label} - review for security`);
    }
    pattern.lastIndex = 0; // reset regex
  }
  return warnings;
}

// ─── ZIP Extraction ──────────────────────────────────────────

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/**
 * Find the root of the ZIP contents.
 * Some ZIPs have all files inside a single top-level folder.
 */
function findZipRoot(zip: JSZip): string {
  const entries = Object.keys(zip.files);
  // Check if all entries share a common top-level directory
  const topDirs = new Set(entries.map(e => e.split('/')[0]));
  if (topDirs.size === 1) {
    const dir = [...topDirs][0];
    // Verify it's actually a directory (has entries inside it)
    if (zip.files[dir + '/'] || entries.some(e => e.startsWith(dir + '/'))) {
      return dir + '/';
    }
  }
  return '';
}

/**
 * Extract and validate a theme ZIP file.
 */
export async function extractTheme(file: File): Promise<ThemeExtractionResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Size check
  if (file.size > MAX_THEME_SIZE) {
    return { valid: false, errors: ['Theme ZIP exceeds 1 MB size limit'], warnings: [], manifest: null, css: '', preview: null };
  }

  let zip: JSZip;
  try {
    const buffer = await file.arrayBuffer();
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { valid: false, errors: ['Invalid ZIP file'], warnings: [], manifest: null, css: '', preview: null };
  }

  const root = findZipRoot(zip);

  // Read manifest
  const manifestFile = zip.file(root + 'manifest.json');
  if (!manifestFile) {
    return { valid: false, errors: ['Missing manifest.json'], warnings: [], manifest: null, css: '', preview: null };
  }

  let manifestData: Record<string, unknown>;
  try {
    const raw = await manifestFile.async('string');
    manifestData = JSON.parse(raw);
  } catch {
    return { valid: false, errors: ['Invalid manifest.json (not valid JSON)'], warnings: [], manifest: null, css: '', preview: null };
  }

  const { result: manifest, errors: manifestErrors } = validateThemeManifest(manifestData);
  errors.push(...manifestErrors);
  if (!manifest) {
    return { valid: false, errors, warnings, manifest: null, css: '', preview: null };
  }

  // Read theme.css
  const cssFile = zip.file(root + 'theme.css');
  if (!cssFile) {
    errors.push('Missing theme.css');
    return { valid: false, errors, warnings, manifest, css: '', preview: null };
  }

  let rawCSS = await cssFile.async('string');

  // Validate CSS safety
  const safety = validateThemeCSSSafety(rawCSS);
  if (!safety.valid) {
    // Sanitize instead of rejecting
    const sanitized = sanitizeThemeCSS(rawCSS);
    rawCSS = sanitized.css;
    warnings.push(...sanitized.warnings);
  }

  // Read preview image if present
  let preview: string | null = null;
  if (manifest.preview) {
    const previewFile = zip.file(root + manifest.preview);
    if (previewFile) {
      try {
        const blob = await previewFile.async('blob');
        preview = await blobToDataUri(blob);
      } catch {
        warnings.push('Could not read preview image');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
    css: rawCSS,
    preview,
  };
}

/**
 * Extract and validate a plugin ZIP file.
 */
export async function extractPlugin(file: File): Promise<PluginExtractionResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (file.size > MAX_PLUGIN_SIZE) {
    return { valid: false, errors: ['Plugin ZIP exceeds 5 MB size limit'], warnings: [], manifest: null, code: '', preview: null };
  }

  let zip: JSZip;
  try {
    const buffer = await file.arrayBuffer();
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { valid: false, errors: ['Invalid ZIP file'], warnings: [], manifest: null, code: '', preview: null };
  }

  const root = findZipRoot(zip);

  // Check for disallowed file extensions
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const ext = getExtension(path);
    if (ext && !ALLOWED_PLUGIN_FILES.has(ext)) {
      errors.push(`Disallowed file type: ${path} (${ext})`);
    }
  }

  // Read manifest
  const manifestFile = zip.file(root + 'manifest.json');
  if (!manifestFile) {
    return { valid: false, errors: ['Missing manifest.json', ...errors], warnings, manifest: null, code: '', preview: null };
  }

  let manifestData: Record<string, unknown>;
  try {
    const raw = await manifestFile.async('string');
    manifestData = JSON.parse(raw);
  } catch {
    return { valid: false, errors: ['Invalid manifest.json (not valid JSON)', ...errors], warnings, manifest: null, code: '', preview: null };
  }

  const { result: manifest, errors: manifestErrors } = validatePluginManifest(manifestData);
  errors.push(...manifestErrors);
  if (!manifest) {
    return { valid: false, errors, warnings, manifest: null, code: '', preview: null };
  }

  // Read entrypoint
  const entryFile = zip.file(root + manifest.entrypoint);
  if (!entryFile) {
    errors.push(`Missing entrypoint file: ${manifest.entrypoint}`);
    return { valid: false, errors, warnings, manifest, code: '', preview: null };
  }

  const code = await entryFile.async('string');

  // JS security checks
  warnings.push(...checkJSSecurity(code));

  // Read preview if present
  let preview: string | null = null;
  const previewFile = zip.file(root + 'preview.png') || zip.file(root + 'preview.svg');
  if (previewFile) {
    try {
      const blob = await previewFile.async('blob');
      preview = await blobToDataUri(blob);
    } catch {
      warnings.push('Could not read preview image');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
    code,
    preview,
  };
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
