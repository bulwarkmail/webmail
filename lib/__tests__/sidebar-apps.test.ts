import { describe, expect, it } from 'vitest';
import {
  appFrameRights,
  DEFAULT_SIDEBAR_APP_ID_PREFIX,
  managedAppOriginsWith,
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

  it("keeps an https image on the app's own origin as its icon", () => {
    const iconUrl = 'https://intranet.example.com/static/favicon-24x24.png';
    expect(sanitizeDefaultSidebarApps([app({ iconUrl: ` ${iconUrl} ` })])[0].iconUrl).toBe(iconUrl);
    expect(sanitizeDefaultSidebarApps([app()])[0]).not.toHaveProperty('iconUrl');
  });

  it("drops an image that is not https or not on the app's origin, and keeps the app", () => {
    for (const iconUrl of [
      'https://cdn.example.com/logo.png',
      'https://intranet.example.com:8443/logo.png',
      'http://intranet.example.com/logo.png',
      'https://user:pw@intranet.example.com/logo.png',
      'data:image/svg+xml,<svg/>',
      'javascript:alert(1)',
      '/logo.png',
      `https://intranet.example.com/${'a'.repeat(2100)}`,
      42,
    ]) {
      const [kept] = sanitizeDefaultSidebarApps([app({ iconUrl })]);
      expect(kept.name, String(iconUrl)).toBe('Intranet');
      expect(kept, String(iconUrl)).not.toHaveProperty('iconUrl');
    }
    // An app served over http gets no image either: no https image shares its origin.
    const [plain] = sanitizeDefaultSidebarApps([
      app({ url: 'http://intranet.example.com', iconUrl: 'https://intranet.example.com/logo.png' }),
    ]);
    expect(plain).not.toHaveProperty('iconUrl');
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

describe('sidebar app frame rights', () => {
  const chat = app({ id: 'admin-app-chat', url: 'https://chat.example.com/team', openMode: 'inline' });
  const base = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

  it('keeps the known features of an inline app, in a fixed order, and drops the rest', () => {
    const [kept] = sanitizeDefaultSidebarApps([
      { ...chat, allow: ['fullscreen', 'geolocation', 'clipboard-write', 'camera', 'camera', 'allow-top-navigation', 42] },
    ]);
    expect(kept.allow).toEqual(['clipboard-write', 'camera', 'fullscreen']);
  });

  it('keeps no `allow` that is not a list, is empty, or belongs to a tab app', () => {
    const kept = sanitizeDefaultSidebarApps([
      { ...chat, id: 'a', allow: 'camera' },
      { ...chat, id: 'b', allow: ['geolocation'] },
      { ...chat, id: 'c', openMode: 'tab', allow: ['camera'] },
    ]);
    expect(kept.map((a) => a.allow)).toEqual([undefined, undefined, undefined]);
    expect(kept.every((a) => !('allow' in a))).toBe(true);
  });

  it('gives an app of the policy downloads, dialogs and its features for its own origin', () => {
    const managed = sanitizeDefaultSidebarApps([{ ...chat, allow: ['clipboard-write', 'microphone', 'camera', 'display-capture', 'fullscreen'] }]);
    expect(appFrameRights({ id: 'admin-app-chat', url: 'https://chat.example.com/team' }, managed)).toEqual({
      sandbox: `${base} allow-downloads allow-modals`,
      allow: 'clipboard-write https://chat.example.com; microphone https://chat.example.com; camera https://chat.example.com; display-capture https://chat.example.com; fullscreen https://chat.example.com',
    });
  });

  it('gives an app of the policy without features downloads and dialogs alone', () => {
    const managed = sanitizeDefaultSidebarApps([chat]);
    expect(appFrameRights({ id: 'admin-app-chat', url: 'https://chat.example.com/' }, managed))
      .toEqual({ sandbox: `${base} allow-downloads allow-modals` });
  });

  it('leaves downloads out while the device policy forbids them', () => {
    const managed = sanitizeDefaultSidebarApps([chat]);
    expect(appFrameRights({ id: 'admin-app-chat', url: chat.url as string }, managed, { downloadsOff: true }).sandbox)
      .toBe(`${base} allow-modals`);
  });

  it('gives a user\'s own app the base sandbox alone, also under an operator\'s id', () => {
    const managed = sanitizeDefaultSidebarApps([{ ...chat, allow: ['camera'] }]);
    expect(appFrameRights({ id: 'my-app', url: 'https://chat.example.com' }, managed)).toEqual({ sandbox: base });
    expect(appFrameRights({ id: 'admin-app-chat', url: 'https://evil.example.com' }, managed)).toEqual({ sandbox: base });
    expect(appFrameRights({ id: 'admin-app-chat', url: 'https://chat.example.com' }, [])).toEqual({ sandbox: base });
  });

  it('lists the origins granted a feature, once each', () => {
    const defaults = [
      { ...chat, allow: ['camera', 'microphone'] },
      { ...chat, id: 'admin-app-2', url: 'https://chat.example.com/other', allow: ['camera'] },
      { ...chat, id: 'admin-app-3', url: 'https://talk.example.com', allow: ['microphone'] },
    ];
    expect(managedAppOriginsWith(defaults, 'camera')).toEqual(['https://chat.example.com']);
    expect(managedAppOriginsWith(defaults, 'microphone')).toEqual(['https://chat.example.com', 'https://talk.example.com']);
    expect(managedAppOriginsWith(undefined, 'camera')).toEqual([]);
  });
});
