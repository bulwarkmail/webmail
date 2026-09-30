import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TARGETS, TARGET_NAMES, getTarget, resolveTarget } from '@/lib/connector/registry';
import { safeAdminNext } from '@/lib/connector/admin-next';

const resolve = (name: string, search: Record<string, string> = {}) =>
  resolveTarget(name, search);

const path = (name: string, search: Record<string, string> = {}) => {
  const result = resolve(name, search);
  if (result.kind !== 'ok') throw new Error(`${name} did not resolve: ${result.kind}`);
  return result.resolution.path;
};

describe('the registry', () => {
  it('has unique names that are safe as one path segment', () => {
    expect(new Set(TARGET_NAMES).size).toBe(TARGET_NAMES.length);
    for (const name of TARGET_NAMES) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('labels every target for the "unknown link" card', () => {
    for (const target of TARGETS) expect(target.label.length).toBeGreaterThan(0);
  });

  it('does not inherit names from Object.prototype', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(getTarget(name)).toBeNull();
      expect(resolve(name).kind).toBe('unknown-target');
    }
  });

  it('reports an unknown target rather than throwing or 404ing', () => {
    expect(resolve('plugin_sandbox_settings').kind).toBe('unknown-target');
    expect(resolveTarget(null, {}).kind).toBe('unknown-target');
    expect(resolveTarget('', {}).kind).toBe('unknown-target');
  });
});

describe('resolving to app paths', () => {
  it('resolves the bare surfaces', () => {
    expect(path('app')).toBe('/mail');
    expect(path('contacts')).toBe('/contacts');
    expect(path('settings')).toBe('/settings');
    expect(path('setup')).toBe('/setup');
  });

  it('resolves a settings tab', () => {
    expect(path('settings', { tab: 'filters' })).toBe('/settings/filters');
  });

  it('resolves a calendar view and date', () => {
    expect(path('calendar')).toBe('/calendar/month');
    expect(path('calendar', { view: 'week' })).toBe('/calendar/week');
    expect(path('calendar', { view: 'day', date: '2026-09-20' })).toBe('/calendar/day/2026-09-20');
  });

  it('resolves a mail folder by alias and by opaque id', () => {
    expect(path('mail_folder', { ref: 'inbox' })).toBe('/mail/folder/inbox');
    expect(path('mail_folder', { ref: 'a1b2c3' })).toBe('/mail/folder/a1b2c3');
    expect(path('mail_folder')).toBe('/mail');
  });

  it('resolves a drive path', () => {
    expect(path('files', { path: 'Documents/Invoices' })).toBe('/files/Documents/Invoices');
    expect(path('files')).toBe('/files');
  });

  it('marks the admin targets, and carries the tab the shell keeps in a store', () => {
    const admin = resolve('admin', { tab: 'policy' });
    expect(admin.kind).toBe('ok');
    if (admin.kind === 'ok') {
      expect(admin.resolution).toEqual({ path: '/admin', adminTab: 'policy', admin: true });
    }

    const auth = resolve('admin_auth');
    if (auth.kind === 'ok') expect(auth.resolution.adminTab).toBe('auth');

    const ext = resolve('admin_extension', { slug: 'quick-reply' });
    if (ext.kind === 'ok') {
      expect(ext.resolution).toEqual({ path: '/admin/marketplace/quick-reply', admin: true });
    }
  });

  it('defaults the admin tab when the link named none', () => {
    const admin = resolve('admin');
    if (admin.kind === 'ok') expect(admin.resolution.adminTab).toBe('dashboard');
  });

  it('leaves the user targets unmarked, so they take the normal login path', () => {
    for (const name of ['app', 'settings', 'calendar', 'contacts', 'files', 'mail_folder']) {
      const result = resolve(name);
      if (result.kind === 'ok') expect(result.resolution.admin).toBeUndefined();
    }
  });
});

describe('parameter validation', () => {
  it('refuses a settings tab that is not a real tab', () => {
    const result = resolve('settings', { tab: 'root' });
    expect(result.kind).toBe('bad-param');
    if (result.kind === 'bad-param') expect(result.param).toBe('tab');
  });

  it('requires a required parameter', () => {
    expect(resolve('admin_extension').kind).toBe('bad-param');
    expect(resolve('admin_extension', { slug: '' }).kind).toBe('bad-param');
  });

  it.each([
    '../../etc/passwd',
    '//evil.example',
    'Quick-Reply',
    'quick reply',
    'javascript:alert(1)',
    'a'.repeat(65),
  ])('refuses the extension slug %j', (slug) => {
    expect(resolve('admin_extension', { slug }).kind).toBe('bad-param');
  });

  it.each(['../admin', 'a/b', 'a\\b', 'a?b', 'a#b', '.', '..'])(
    'refuses the mailbox ref %j',
    (ref) => {
      expect(resolve('mail_folder', { ref }).kind).toBe('bad-param');
    },
  );

  it.each(['2026-02-31', '2026-13-01', '20260920', 'tomorrow'])(
    'refuses the date %j',
    (date) => {
      expect(resolve('calendar', { date }).kind).toBe('bad-param');
    },
  );

  it.each(['../secrets', 'Documents/../../etc', 'a?b'])('refuses the drive path %j', (p) => {
    expect(resolve('files', { path: p }).kind).toBe('bad-param');
  });

  it('refuses an over-long value whatever its shape', () => {
    expect(resolve('mail_folder', { ref: 'a'.repeat(513) }).kind).toBe('bad-param');
  });

  it('drops a parameter the target does not declare, rather than forwarding it', () => {
    // A connector newer than this instance may carry something extra; the link
    // should still open the surface it named.
    expect(path('settings', { tab: 'filters', redirect: 'https://evil.example' })).toBe(
      '/settings/filters',
    );
  });

  it('never lets a parameter escape its path segment', () => {
    for (const hostile of ['../admin', '..%2Fadmin', 'a/../../b']) {
      const result = resolve('mail_folder', { ref: hostile });
      if (result.kind === 'ok') {
        // If it was accepted at all, it must still be a single segment.
        const tail = result.resolution.path.replace('/mail/folder/', '');
        expect(tail).not.toContain('/');
        expect(decodeURIComponent(tail)).not.toContain('..');
      }
    }
  });
});

describe('safeAdminNext', () => {
  it.each([
    ['/admin', '/admin'],
    ['/admin/', '/admin/'],
    ['/admin/marketplace/quick-reply', '/admin/marketplace/quick-reply'],
    ['/admin?tab=policy', '/admin?tab=policy'],
    ['%2Fadmin%2Fplugins%2Fx', '/admin/plugins/x'],
  ])('accepts %j', (raw, expected) => {
    expect(safeAdminNext(raw)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    '/mail',
    '/settings/filters',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/admin/../mail',
    '/adminfoo',
    '/admin?tab=policy&x=1',
    '/admin?next=https://evil.example',
    '%2f%2fevil.example',
    '/admin/' + 'a'.repeat(600),
  ])('refuses %j', (raw) => {
    expect(safeAdminNext(raw as string | null)).toBeNull();
  });
});

describe('parity with the connector', () => {
  // The connector (github.com/bulwarkmail/connector) owns the names and the
  // parameter schemas; this side owns the paths. When both checkouts are
  // present, the names must match exactly - a target this side cannot resolve
  // would be a published link that 404s, and one the connector never emits is
  // dead code here.
  const connectorRegistry = join(process.cwd(), 'repos', 'connector', 'src', 'lib', 'registry.ts');

  it.skipIf(!existsSync(connectorRegistry))('names the same targets', () => {
    const source = readFileSync(connectorRegistry, 'utf8');
    const theirs = [...source.matchAll(/^\s{4}name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
    expect(theirs.length).toBeGreaterThan(0);
    expect([...theirs].sort()).toEqual([...TARGET_NAMES].sort());
  });

  it.skipIf(!existsSync(connectorRegistry))(
    'never names a target after a path the connector site owns',
    () => {
      const source = readFileSync(connectorRegistry, 'utf8');
      const reserved = /RESERVED_PATHS = \[([^\]]+)\]/
        .exec(source)?.[1]
        .match(/"([a-z-]+)"/g)
        ?.map((s) => s.replace(/"/g, '')) ?? [];
      expect(reserved.length).toBeGreaterThan(0);
      for (const name of TARGET_NAMES) expect(reserved).not.toContain(name);
    },
  );
});
