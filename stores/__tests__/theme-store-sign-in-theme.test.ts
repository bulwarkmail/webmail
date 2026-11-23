import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));
vi.mock('@/lib/plugin-storage', () => ({
  pluginStorage: {
    saveThemeCSS: vi.fn(async () => {}),
    getThemeCSS: vi.fn(async () => null),
    deleteThemeCSS: vi.fn(async () => {}),
    deleteThemeSkin: vi.fn(async () => {}),
    deletePreview: vi.fn(async () => {}),
    getThemeSkin: vi.fn(async () => null),
    saveThemeSkin: vi.fn(async () => {}),
  },
}));

import { useThemeStore } from '../theme-store';
import { usePolicyStore } from '../policy-store';
import { BUILTIN_THEMES } from '@/lib/builtin-themes';
import { DEFAULT_POLICY, DEFAULT_THEME_POLICY, type SignInTheme, type ThemePolicy } from '@/lib/admin/types';
import type { InstalledTheme } from '@/lib/plugin-types';

// #1846: the admin's default or forced theme reached a browser only with the
// theme list after signing in, so the sign-in page of a browser that never
// signed in had the stock colours.

const CSS = ':root { --color-primary: 46 19 70; } .dark { --color-primary: 46 19 70; }';

const CORP: SignInTheme = {
  id: 'corp', name: 'Corp', version: '1.0.0', author: 'IT', description: '',
  variants: ['light', 'dark'], forceEnabled: false, hasSkin: false, contentHash: 'abc',
};

const theme = () => useThemeStore.getState();

/** The policy as the server answers a visitor who is not signed in. */
function loadVisitorPolicy(signInTheme: SignInTheme | null, themePolicy: Partial<ThemePolicy> = {}) {
  usePolicyStore.setState({
    policy: { ...DEFAULT_POLICY, themePolicy: { ...DEFAULT_THEME_POLICY, ...themePolicy }, signInTheme },
    loaded: true,
  });
}

function respond(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => init.text ?? '',
  };
}

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    // Before signing in the theme list is refused; the CSS is served to anyone.
    if (url === '/api/plugins') return respond({ error: 'Not authenticated' }, { ok: false, status: 401 });
    if (url.startsWith('/api/admin/themes/corp/css')) return respond(null, { text: CSS });
    return respond(null, { ok: false, status: 404 });
  });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: false });
  useThemeStore.setState({
    theme: 'system',
    themeChosen: false,
    activeThemeId: null,
    themeChoiceMade: false,
    installedThemes: [...BUILTIN_THEMES],
    hydrated: false,
  });
  theme().initializeTheme();
});

const settle = () => vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

describe('the admin theme on the sign-in page (#1846)', () => {
  it('installs and applies the default theme in a browser that never signed in', async () => {
    loadVisitorPolicy(CORP, { defaultThemeId: 'corp' });
    await vi.waitFor(() => expect(theme().activeThemeId).toBe('corp'));
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/themes/corp/css?v=abc');
    expect(theme().installedThemes.find((t) => t.id === 'corp')).toMatchObject({ managed: true, css: expect.stringContaining('46 19 70') });
    expect(theme().themeChoiceMade).toBe(false);
  });

  it('applies the theme switched on for everyone over a theme the visitor picked', async () => {
    theme().activateTheme('builtin-nord');
    loadVisitorPolicy({ ...CORP, forceEnabled: true });
    await vi.waitFor(() => expect(theme().activeThemeId).toBe('corp'));
  });

  it('keeps a theme the visitor picked when the admin theme is only the default', async () => {
    theme().activateTheme('builtin-nord');
    loadVisitorPolicy(CORP, { defaultThemeId: 'corp' });
    await settle();
    await vi.waitFor(() => expect(theme().installedThemes.some((t) => t.id === 'corp')).toBe(true));
    expect(theme().activeThemeId).toBe('builtin-nord');
  });

  it('stops forcing a theme the server no longer forces, and removes nothing', async () => {
    const old: InstalledTheme = {
      id: 'old', name: 'Old', version: '1.0.0', author: 'IT', description: '', css: CSS,
      variants: ['light', 'dark'], enabled: true, builtIn: false, managed: true, forceEnabled: true,
    };
    useThemeStore.setState({ installedThemes: [...BUILTIN_THEMES, old] });
    loadVisitorPolicy(null);
    await vi.waitFor(() => expect(theme().installedThemes.find((t) => t.id === 'old')?.forceEnabled).toBe(false));
    expect(theme().installedThemes.some((t) => t.id === 'old')).toBe(true);
  });

  it('does nothing with a policy that has no sign-in theme field (signed in)', async () => {
    usePolicyStore.setState({
      policy: { ...DEFAULT_POLICY, themePolicy: { ...DEFAULT_THEME_POLICY, defaultThemeId: 'corp' } },
      loaded: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(theme().activeThemeId).toBeNull();
  });
});
