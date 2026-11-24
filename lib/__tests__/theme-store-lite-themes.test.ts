/**
 * #1582: Lite has no admin dashboard, so a deployment's own themes are
 * static files next to policy.json: themes.json lists them, and each one's
 * CSS is themes/<id>/theme.css (and skin.css).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lite')>()),
  IS_LITE: true,
}));

const files: Record<string, string> = {};
const fetched: string[] = [];
vi.mock('@/lib/browser-navigation', async (orig) => ({
  ...(await orig<typeof import('@/lib/browser-navigation')>()),
  apiFetch: vi.fn(async (url: string) => {
    fetched.push(url);
    const path = url.split('?')[0];
    return path in files ? new Response(files[path]) : new Response('missing', { status: 404 });
  }),
}));
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

import { parseLiteThemes, useThemeStore } from '@/stores/theme-store';
import { usePolicyStore } from '@/stores/policy-store';

const builtIns = () => useThemeStore.getState().installedThemes.filter((t) => t.builtIn);

beforeEach(() => {
  for (const key of Object.keys(files)) delete files[key];
  fetched.length = 0;
  useThemeStore.setState({ installedThemes: builtIns(), activeThemeId: null, themeChoiceMade: false, hydrated: true });
});

describe('themes of a Lite deployment', () => {
  it('installs the themes themes.json lists, with their CSS and skin', async () => {
    files['/themes.json'] = JSON.stringify({ themes: [
      { id: 'acme', name: 'Acme', version: '1.0.0', author: 'IT', description: 'Our colours', variants: ['light', 'dark'], hasSkin: true, contentHash: 'h1' },
    ] });
    files['/themes/acme/theme.css'] = ':root{--color-primary:#0066cc}';
    files['/themes/acme/skin.css'] = '.message-list{border-radius:8px}';

    await useThemeStore.getState().syncServerThemes();

    const acme = useThemeStore.getState().installedThemes.find((t) => t.id === 'acme');
    expect(acme?.managed).toBe(true);
    expect(acme?.css).toContain('#0066cc');
    expect(acme?.skin).toContain('border-radius');
    // Never the dashboard's routes: Lite has none.
    expect(fetched.some((url) => url.startsWith('/api/'))).toBe(false);
  });

  it("uses the theme the policy's default names", async () => {
    files['/themes.json'] = JSON.stringify({ themes: [{ id: 'acme', name: 'Acme', variants: ['light', 'dark'] }] });
    files['/themes/acme/theme.css'] = ':root{--color-primary:#0066cc}';
    // In Lite a new policy brings the themes too, before anyone signs in.
    usePolicyStore.setState((s) => ({ policy: { ...s.policy, themePolicy: { ...s.policy.themePolicy, defaultThemeId: 'acme' } } }));

    await useThemeStore.getState().syncServerThemes();

    expect(useThemeStore.getState().activeThemeId).toBe('acme');
  });

  it('removes a theme themes.json no longer lists, and treats no file as no themes', async () => {
    files['/themes.json'] = JSON.stringify({ themes: [{ id: 'acme', name: 'Acme' }] });
    files['/themes/acme/theme.css'] = ':root{--color-primary:#0066cc}';
    await useThemeStore.getState().syncServerThemes();
    expect(useThemeStore.getState().installedThemes.some((t) => t.id === 'acme')).toBe(true);

    delete files['/themes.json'];
    await useThemeStore.getState().syncServerThemes();
    expect(useThemeStore.getState().installedThemes.some((t) => t.id === 'acme')).toBe(false);
  });
});

describe('parseLiteThemes', () => {
  it('keeps well-formed entries and fills in what may be left out', () => {
    expect(parseLiteThemes({ themes: [
      { id: 'acme', name: 'Acme' },
      { id: 'night', name: 'Night', variants: ['dark', 'sepia'], forceEnabled: true },
      { id: '../evil', name: 'Evil' },
      { id: 'acme', name: 'Twice' },
      { id: 'nameless' },
      'junk',
    ] })).toEqual([
      { id: 'acme', name: 'Acme', version: '1.0.0', author: '', description: '', variants: ['light', 'dark'], forceEnabled: false, hasSkin: false },
      { id: 'night', name: 'Night', version: '1.0.0', author: '', description: '', variants: ['dark'], forceEnabled: true, hasSkin: false },
    ]);
    expect(parseLiteThemes([{ id: 'acme', name: 'Acme' }])).toEqual([]);
  });
});
