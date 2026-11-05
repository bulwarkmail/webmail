import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { LITE_INTL_ASSETS_OFF, LITE_INTL_ASSETS_REQUEST } from '../../scripts/lite-intl-assets.mjs';

// What a cold start loads before the sign-in form or the first rows: every
// module the root layouts and the mail page import statically. Code behind
// import() or next/dynamic is a chunk of its own and isn't followed. On
// 2026-11-05 the rig measured a cold start a second slower than 1.15.0, most
// of it script the browser parsed and ran before it could draw anything:
// English twice (in the page and in the script), the rich text editor, and
// the desktop app's and offline mode's hosts. These stay out of that set.

const ROOT = resolve(__dirname, '../..');
const ENTRIES = ['app/(main)/layout.tsx', 'app/(main)/[locale]/layout.tsx', 'app/(main)/[locale]/page.tsx'];
const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'];
// `import x from`, `import { a, b } from`, `export { a } from`, `import 'x'`; not `import type`.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolveImport(from: string, spec: string): string | null {
  // The swap next.config.ts makes in every build but Lite.
  if (LITE_INTL_ASSETS_REQUEST.test(spec)) spec = LITE_INTL_ASSETS_OFF;
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return `node_modules/${spec}`;
  for (const ext of EXTS) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

function onlyTypes(statement: string): boolean {
  // `import { type A, type B } from` brings no code.
  const names = /\{([^}]*)\}/.exec(statement)?.[1];
  if (!names || /^\s*import\s+\w/.test(statement.replace(/^\s*import\s+\{/, 'import {'))) return false;
  return names.split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '));
}

function bootModules(): Set<string> {
  const seen = new Set<string>();
  const queue = ENTRIES.map((e) => join(ROOT, e));
  for (const q of queue) seen.add(q);
  while (queue.length) {
    const file = queue.shift()!;
    if (file.startsWith('node_modules/') || file.endsWith('.json')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(STATIC_IMPORT)) {
      if (onlyTypes(match[0])) continue;
      const target = resolveImport(file, match[1]);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return new Set([...seen].map((p) => (p.startsWith('node_modules/') ? p : relative(ROOT, p).replace(/\\/g, '/'))));
}

describe('what a cold start imports', () => {
  const modules = bootModules();
  const reached = (prefix: string) => [...modules].filter((m) => m.startsWith(prefix));

  it('finds the mail app, so the walk itself works', () => {
    expect(modules.has('components/mail/mail-app.tsx')).toBe(true);
    expect(modules.has('stores/email-store.ts')).toBe(true);
  });

  it('leaves English to the server catalog (Lite keeps its own copy)', () => {
    expect(reached('locales/')).toEqual([]);
    expect(modules.has('components/providers/lite-intl-assets.off.ts')).toBe(true);
    expect(modules.has('components/providers/lite-intl-assets.tsx')).toBe(false);
  });

  it('leaves the rich text editor to the composer', () => {
    expect(reached('node_modules/@tiptap')).toEqual([]);
    expect(reached('node_modules/prosemirror')).toEqual([]);
    expect(modules.has('components/email/signature-block.ts')).toBe(false);
  });

  it('leaves the page skeletons of other surfaces to Lite and loading pages', () => {
    expect(modules.has('components/boot-skeleton/route-skeleton.tsx')).toBe(false);
    expect(modules.has('components/admin/admin-page-icons.ts')).toBe(false);
  });

  it('loads the desktop app hosts only in the desktop app', () => {
    for (const host of [
      'components/desktop/desktop-host.tsx',
      'components/desktop/desktop-os-host.tsx',
      'components/desktop/edited-files-host.tsx',
      'components/providers/files-sync-host.tsx',
      'components/files-sync/files-sync-prompts.tsx',
      'components/layout/window-menu-bar.tsx',
    ]) expect(modules.has(host), host).toBe(false);
    // The sync engine; its small flags and notices are shared with the page.
    for (const engine of ['lib/files-sync/engine.ts', 'lib/files-sync/host.ts', 'lib/files-sync/root-sync.ts']) expect(modules.has(engine), engine).toBe(false);
  });

  it('loads the hosts of background work after the first screen', () => {
    for (const host of [
      'components/mail-transfer/mail-transfer-host.tsx',
      'components/offline/offline-host.tsx',
      'components/popout/popout-host.tsx',
      'components/file-drop/file-drop-host.tsx',
      'components/providers/notification-actions-host.tsx',
    ]) expect(modules.has(host), host).toBe(false);
    for (const engine of ['lib/mail-import/engine.ts', 'lib/mail-export/engine.ts']) expect(modules.has(engine), engine).toBe(false);
  });
});
