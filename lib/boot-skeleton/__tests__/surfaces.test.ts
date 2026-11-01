import { beforeEach, describe, expect, it } from 'vitest';
import { TARGET_NAMES, getTarget } from '@/lib/connector/registry';
import { locales } from '@/i18n/routing';
import { CONNECTOR_SURFACES, surfaceFromPath } from '../surfaces';
import { BOOT_HINTS_KEY } from '../keys';
import { resetRailHintsMemo, writeRailHints, writeSettingsHints } from '../hints';

describe('connector targets', () => {
  it('every target the connector can resolve has a skeleton surface', () => {
    for (const name of TARGET_NAMES) expect(CONNECTOR_SURFACES[name], name).toBeTruthy();
    expect(Object.keys(CONNECTOR_SURFACES).sort()).toEqual([...TARGET_NAMES].sort());
  });

  it('the surface matches where the target resolves to', () => {
    const firstSegment: Record<string, string> = { '': 'mail' };
    for (const name of TARGET_NAMES) {
      const target = getTarget(name)!;
      const params: Record<string, string> = {};
      for (const [key, spec] of Object.entries(target.params ?? {})) {
        if (!spec.required) continue;
        params[key] = spec.type === 'enum' ? spec.values![0] : 'x';
      }
      const { path } = target.resolve(params);
      const seg = path.split('/').filter(Boolean)[0] ?? '';
      expect(CONNECTOR_SURFACES[name], `${name} -> ${path}`).toBe(firstSegment[seg] ?? seg);
    }
  });
});

describe('surfaceFromPath', () => {
  it.each([
    ['/', 'mail'],
    ['/en', 'mail'],
    ['/de/mail/folder/inbox', 'mail'],
    ['/en/calendar/week/2026-11-04', 'calendar'],
    ['/ar/contacts/abc', 'contacts'],
    ['/en/files/de', 'files'],
    ['/en/apps/p/q', 'apps'],
    ['/en/settings/filters', 'settings'],
    ['/en/pro', 'pro'],
    ['/en/login', 'login'],
    ['/admin', 'admin'],
    ['/admin/logs', 'admin'],
    ['/admin/login', 'admin-login'],
    ['/setup', 'setup'],
    ['/connector/calendar', 'calendar'],
    ['/connector/admin_auth', 'admin'],
    ['/connector/nope', null],
    ['/protocol/mailto', 'mail'],
    ['/protocol/webcal', 'calendar'],
    ['/webmail/de/calendar', 'calendar'],
    ['/en/auth/callback', null],
    ['/en/plugins/oauth/callback', null],
  ])('%s -> %s', (path, surface) => {
    expect(surfaceFromPath(path, locales)).toBe(surface);
  });
});

describe('rail hints', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRailHintsMemo();
  });

  it('stores the rail items with mail first', () => {
    writeRailHints(['calendar', 'quota']);
    expect(JSON.parse(localStorage.getItem(BOOT_HINTS_KEY)!)).toEqual({ v: 1, rail: ['mail', 'calendar', 'quota'] });
  });

  it('skips writing the same value twice', () => {
    writeRailHints(['files']);
    localStorage.removeItem(BOOT_HINTS_KEY);
    writeRailHints(['files']);
    expect(localStorage.getItem(BOOT_HINTS_KEY)).toBeNull();
    writeRailHints(['files', 'admin']);
    expect(JSON.parse(localStorage.getItem(BOOT_HINTS_KEY)!).rail).toEqual(['mail', 'files', 'admin']);
  });

  it('keeps the rail and the settings pages side by side', () => {
    writeRailHints(['calendar']);
    writeSettingsHints(['account', 'filters']);
    expect(JSON.parse(localStorage.getItem(BOOT_HINTS_KEY)!)).toEqual({ v: 1, rail: ['mail', 'calendar'], settings: ['account', 'filters'] });
    writeRailHints(['files']);
    expect(JSON.parse(localStorage.getItem(BOOT_HINTS_KEY)!)).toEqual({ v: 1, rail: ['mail', 'files'], settings: ['account', 'filters'] });
  });
});
