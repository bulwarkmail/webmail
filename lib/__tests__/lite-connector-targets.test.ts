// connector.json is the static stand-in for /api/connector/capabilities. A Lite
// export has no admin console and no setup wizard (scripts/lite/lib.mjs
// LITE_REMOVED_PATHS removes app/(main)/admin and app/(main)/setup), so it lists
// only the targets it can open, and exports no connector page for the others.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LITE_REMOVED_PATHS, buildConnectorCapabilities, connectorTargetsFromSource } from '../../scripts/lite/lib.mjs';
import { runPostbuild } from '../../scripts/lite/postbuild.mjs';
import { TARGET_NAMES, resolveTarget } from '@/lib/connector/registry';

describe('connector.json of a Lite export', () => {
  const capabilities = JSON.parse(buildConnectorCapabilities({ appName: 'Acme', version: '1.2.3', basePath: '' })) as { targets: string[] };

  it('lists no target whose page the export does not have', () => {
    const removed = (LITE_REMOVED_PATHS as string[])
      .filter((path) => path.startsWith('app/(main)/'))
      .map((path) => `/${path.slice('app/(main)/'.length)}`); // "/admin", "/setup", ...
    const dead: string[] = [];
    for (const name of capabilities.targets) {
      // Parameters that satisfy every target; unknown ones are ignored.
      const result = resolveTarget(name, new URLSearchParams({ id: 'x', tab: 'general', ref: 'inbox', path: '/' }));
      if (result.kind !== 'ok') continue;
      const path = result.resolution.path;
      if (removed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) dead.push(`${name} -> ${path}`);
    }
    expect(dead).toEqual([]);
  });

  // Control: the targets Lite does serve stay listed.
  it('still lists the mail, calendar, contacts, files and settings targets', () => {
    for (const name of ['app', 'settings', 'mail_folder', 'calendar', 'contacts', 'files']) {
      expect(capabilities.targets).toContain(name);
    }
  });

  it('leaves out every target that needs the admin session, by what the registry says', () => {
    for (const name of TARGET_NAMES) {
      const result = resolveTarget(name, new URLSearchParams({ id: 'x', slug: 'x', tab: 'general', ref: 'inbox', path: '/' }));
      if (result.kind === 'ok' && result.resolution.admin) expect(capabilities.targets, name).not.toContain(name);
    }
  });

  it('leaves out a target added later that needs the admin session, without a list to edit', () => {
    const source = readFileSync(join(process.cwd(), 'lib', 'connector', 'registry.ts'), 'utf8');
    const added = source.replace('] as const;', [
      '  {',
      "    name: 'admin_new_page',",
      "    label: 'a new admin page',",
      "    resolve: () => ({ path: '/mail/x', admin: true }),",
      '  },',
      '  {',
      "    name: 'mail_new_page',",
      "    label: 'a new mail page',",
      "    resolve: () => ({ path: '/mail/new' }),",
      '  },',
      '] as const;',
    ].join('\n'));
    const targets = connectorTargetsFromSource(added);
    expect(targets.find((t: { name: string }) => t.name === 'admin_new_page')).toEqual({ name: 'admin_new_page', lite: false });
    expect(targets.find((t: { name: string }) => t.name === 'mail_new_page')).toEqual({ name: 'mail_new_page', lite: true });
    expect(targets.find((t: { name: string }) => t.name === 'setup')).toEqual({ name: 'setup', lite: false });
  });

  it('exports no connector page for a target it left out', () => {
    const root = mkdtempSync(join(tmpdir(), 'bulwark-lite-connector-'));
    try {
      const out = join(root, 'out');
      for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login']) {
        mkdirSync(join(out, 'en', surface), { recursive: true });
        writeFileSync(join(out, 'en', surface, 'index.html'), '<html></html>');
      }
      for (const name of TARGET_NAMES) {
        mkdirSync(join(out, 'connector', name), { recursive: true });
        writeFileSync(join(out, 'connector', name, 'index.html'), '<html></html>');
      }
      runPostbuild({ root, env: {} as unknown as NodeJS.ProcessEnv, log: () => {} });
      const listed = (JSON.parse(readFileSync(join(out, 'connector.json'), 'utf8')) as { targets: string[] }).targets;
      for (const name of TARGET_NAMES) {
        expect(existsSync(join(out, 'connector', name, 'index.html')), name).toBe(listed.includes(name));
      }
      expect(existsSync(join(out, 'connector', 'admin_auth'))).toBe(false);
      expect(existsSync(join(out, 'connector', 'setup'))).toBe(false);
      expect(existsSync(join(out, 'connector', 'app', 'index.html'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
