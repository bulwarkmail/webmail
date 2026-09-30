import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_APP_ID_PREFIX,
  MAX_DEFAULT_SIDEBAR_APPS,
  mergeSidebarApps,
  sanitizeDefaultSidebarApps,
} from '@/lib/sidebar-apps';
import { inlineAppFrameOrigins } from '@/lib/security/app-frame-origins';

const app = (over: Record<string, unknown> = {}) => ({
  id: 'admin-app-1',
  name: 'Intranet',
  url: 'https://intranet.example.com',
  icon: 'Globe',
  openMode: 'tab',
  showOnMobile: false,
  ...over,
});

describe('sanitizeDefaultSidebarApps', () => {
  it('keeps a well-formed app as-is', () => {
    expect(sanitizeDefaultSidebarApps([app()])).toEqual([
      {
        id: 'admin-app-1',
        name: 'Intranet',
        url: 'https://intranet.example.com',
        icon: 'Globe',
        openMode: 'tab',
        showOnMobile: false,
      },
    ]);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(sanitizeDefaultSidebarApps(undefined)).toEqual([]);
    expect(sanitizeDefaultSidebarApps(null)).toEqual([]);
    expect(sanitizeDefaultSidebarApps({})).toEqual([]);
    expect(sanitizeDefaultSidebarApps('https://example.com')).toEqual([]);
  });

  it('drops entries without a usable name or URL', () => {
    expect(sanitizeDefaultSidebarApps([
      app({ name: '   ' }),
      app({ name: 42 }),
      app({ url: '' }),
      app({ url: 'not a url' }),
      app({ url: 'javascript:alert(1)' }),
      app({ url: 'data:text/html,<h1>x</h1>' }),
      app({ url: `https://example.com/${'a'.repeat(2100)}` }),
      null,
      'nope',
    ])).toEqual([]);
  });

  it('keeps the good entries when one is malformed', () => {
    const result = sanitizeDefaultSidebarApps([app({ id: 'a', url: 'nope' }), app({ id: 'b' })]);
    expect(result.map((a) => a.name)).toEqual(['Intranet']);
    expect(result[0].id).toBe('admin-app-b');
  });

  it('falls back to a known icon for anything that cannot resolve', () => {
    expect(sanitizeDefaultSidebarApps([app({ icon: 'Globe/../../etc' })])[0].icon).toBe('Globe');
    expect(sanitizeDefaultSidebarApps([app({ icon: '' })])[0].icon).toBe('Globe');
    expect(sanitizeDefaultSidebarApps([app({ icon: 12 })])[0].icon).toBe('Globe');
    expect(sanitizeDefaultSidebarApps([app({ icon: 'Rss' })])[0].icon).toBe('Rss');
    expect(sanitizeDefaultSidebarApps([app({ icon: 'tabler:brand-github' })])[0].icon).toBe('tabler:brand-github');
    expect(sanitizeDefaultSidebarApps([app({ icon: 'tabler:../x' })])[0].icon).toBe('Globe');
  });

  it('coerces openMode and showOnMobile', () => {
    const [tab, inline] = sanitizeDefaultSidebarApps([
      app({ id: 'a', openMode: 'popup', showOnMobile: 'yes' }),
      app({ id: 'b', openMode: 'inline', showOnMobile: true }),
    ]);
    expect(tab.openMode).toBe('tab');
    expect(tab.showOnMobile).toBe(false);
    expect(inline.openMode).toBe('inline');
    expect(inline.showOnMobile).toBe(true);
  });

  it('namespaces ids so a hand-written policy cannot shadow a user app', () => {
    const [first, second] = sanitizeDefaultSidebarApps([
      app({ id: 'app-user-owned' }),
      app({ id: '../../evil id' }),
    ]);
    expect(first.id.startsWith(DEFAULT_SIDEBAR_APP_ID_PREFIX)).toBe(true);
    expect(second.id).toMatch(/^admin-app-[a-zA-Z0-9_-]*$/);
  });

  it('de-duplicates ids so React keys stay unique', () => {
    const ids = sanitizeDefaultSidebarApps([app({ id: 'x' }), app({ id: 'x' }), app({ id: 'x' })])
      .map((a) => a.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('gives an entry with no id one derived from its position', () => {
    const [only] = sanitizeDefaultSidebarApps([app({ id: undefined })]);
    expect(only.id).toBe('admin-app-1');
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_DEFAULT_SIDEBAR_APPS + 5 }, (_, i) => app({ id: `a${i}` }));
    expect(sanitizeDefaultSidebarApps(many)).toHaveLength(MAX_DEFAULT_SIDEBAR_APPS);
  });

  it('trims a name to the length the admin form allows', () => {
    expect(sanitizeDefaultSidebarApps([app({ name: 'x'.repeat(80) })])[0].name).toHaveLength(50);
  });
});

describe('mergeSidebarApps', () => {
  const userApp = {
    id: 'app-abc',
    name: 'My app',
    url: 'https://mine.example.com',
    icon: 'Rss',
    openMode: 'tab' as const,
    showOnMobile: false,
  };

  it('lists admin apps first and flags them managed', () => {
    const merged = mergeSidebarApps([app()], [userApp]);
    expect(merged.map((a) => a.id)).toEqual(['admin-app-1', 'app-abc']);
    expect(merged[0].managed).toBe(true);
    expect(merged[1].managed).toBeUndefined();
  });

  it('works with either side missing', () => {
    expect(mergeSidebarApps(undefined, [userApp]).map((a) => a.id)).toEqual(['app-abc']);
    expect(mergeSidebarApps([app()], undefined).map((a) => a.id)).toEqual(['admin-app-1']);
    expect(mergeSidebarApps(null, null)).toEqual([]);
  });

  it('lets an admin app win an id collision', () => {
    const merged = mergeSidebarApps([app({ id: 'admin-app-1' })], [{ ...userApp, id: 'admin-app-1' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Intranet');
  });

  it('preserves the admin-configured order', () => {
    const merged = mergeSidebarApps(
      [app({ id: 'b', name: 'B' }), app({ id: 'a', name: 'A' })],
      [userApp]
    );
    expect(merged.map((a) => a.name)).toEqual(['B', 'A', 'My app']);
  });
});

describe('CSP origins for admin apps', () => {
  it('covers only the inline ones, which are the ones that get framed', () => {
    const apps = sanitizeDefaultSidebarApps([
      app({ id: 'a', url: 'https://framed.example.com/app', openMode: 'inline' }),
      app({ id: 'b', url: 'https://newtab.example.com', openMode: 'tab' }),
    ]);
    expect(inlineAppFrameOrigins(apps)).toEqual(['https://framed.example.com']);
  });
});
