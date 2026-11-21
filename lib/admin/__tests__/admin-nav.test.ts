import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_PAGES, ADMIN_PAGE_IDS, adminPath, isAdminPageId, parseAdminPath } from '../admin-nav';

describe('admin page URLs', () => {
  it('reads the page and the detail from a pathname', () => {
    expect(parseAdminPath('/admin')).toEqual({ page: null, detail: null });
    expect(parseAdminPath('/admin/')).toEqual({ page: null, detail: null });
    expect(parseAdminPath('/admin/settings')).toEqual({ page: 'settings', detail: null });
    expect(parseAdminPath('/admin/plugins/jitsi-meet')).toEqual({ page: 'plugins', detail: 'jitsi-meet' });
    expect(parseAdminPath('/admin/marketplace/quick-reply')).toEqual({ page: 'marketplace', detail: 'quick-reply' });
  });

  it('decodes a detail id and keeps slashes inside it', () => {
    expect(parseAdminPath('/admin/plugins/acme%2Fwidget')).toEqual({ page: 'plugins', detail: 'acme/widget' });
    expect(parseAdminPath('/admin/plugins/acme/widget')).toEqual({ page: 'plugins', detail: 'acme/widget' });
  });

  it('ignores a detail on pages that have none, and an unknown page', () => {
    expect(parseAdminPath('/admin/settings/anything')).toEqual({ page: 'settings', detail: null });
    expect(parseAdminPath('/admin/nope')).toEqual({ page: null, detail: null });
  });

  it('is null outside the admin tree', () => {
    expect(parseAdminPath('/mail')).toBeNull();
    expect(parseAdminPath('/administration')).toBeNull();
    expect(parseAdminPath('/en/admin')).toBeNull();
  });

  it('builds the paths it parses', () => {
    expect(adminPath()).toBe('/admin');
    expect(adminPath(null)).toBe('/admin');
    expect(adminPath('policy')).toBe('/admin/policy');
    expect(adminPath('themes', 'nord')).toBe('/admin/themes/nord');
    expect(adminPath('plugins', 'acme/widget')).toBe('/admin/plugins/acme%2Fwidget');
    for (const id of ADMIN_PAGE_IDS) {
      expect(parseAdminPath(adminPath(id))).toEqual({ page: id, detail: null });
    }
    expect(parseAdminPath(adminPath('plugins', 'acme/widget'))).toEqual({ page: 'plugins', detail: 'acme/widget' });
  });

  it('knows its page ids', () => {
    expect(isAdminPageId('plugins')).toBe(true);
    expect(isAdminPageId('login')).toBe(false);
    expect(isAdminPageId(null)).toBe(false);
  });

  it('lists every section of the policy page, so the admin search finds it', () => {
    const source = readFileSync(join(process.cwd(), 'app/(main)/admin/_pages/policy.tsx'), 'utf8');
    const pageIds = [...source.matchAll(/<SettingsSection\s+id="([^"]+)"/g)].map((m) => m[1]);
    expect(pageIds.length).toBeGreaterThan(0);
    const navIds = ADMIN_PAGES.find((p) => p.id === 'policy')!.sections.map((s) => s.id);
    for (const id of pageIds) expect(navIds).toContain(id);
  });

  it('registers every page once, with the detail flag only where a detail page exists', () => {
    expect(ADMIN_PAGES.map((p) => p.id)).toEqual([...ADMIN_PAGE_IDS]);
    expect(ADMIN_PAGES.filter((p) => p.hasDetail).map((p) => p.id)).toEqual(['plugins', 'themes', 'marketplace']);
    for (const page of ADMIN_PAGES) {
      const ids = page.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
