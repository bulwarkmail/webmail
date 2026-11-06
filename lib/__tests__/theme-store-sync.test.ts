import { describe, it, expect, vi, beforeEach } from 'vitest';

const serverThemes: { themes: unknown[] } = { themes: [] };
const assets: Record<string, string> = {};
vi.mock('@/lib/browser-navigation', async (orig) => ({
  ...(await orig<typeof import('@/lib/browser-navigation')>()),
  apiFetch: vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    if (path === '/api/plugins') return new Response(JSON.stringify({ plugins: [], ...serverThemes }));
    return path in assets ? new Response(assets[path]) : new Response('missing', { status: 404 });
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

import { useThemeStore } from '@/stores/theme-store';
import { pluginStorage } from '@/lib/plugin-storage';
import type { InstalledTheme } from '@/lib/plugin-types';

const CORP: InstalledTheme = {
  id: 'corp', name: 'Corp', version: '1.0.0', author: 'IT', description: '',
  css: ':root{--color-primary:red}', variants: ['light', 'dark'],
  enabled: true, builtIn: false, managed: true, forceEnabled: true,
};

beforeEach(() => {
  serverThemes.themes = [];
  const builtIns = useThemeStore.getState().installedThemes.filter((t) => t.builtIn);
  useThemeStore.setState({ installedThemes: [...builtIns, CORP], activeThemeId: 'corp' });
});

describe('server theme sync', () => {
  it('drops a managed theme the admin deleted, and stops forcing it', async () => {
    await useThemeStore.getState().syncServerThemes();

    const state = useThemeStore.getState();
    expect(state.installedThemes.some((t) => t.id === 'corp')).toBe(false);
    expect(state.activeThemeId).toBeNull();
    expect(pluginStorage.deleteThemeCSS).toHaveBeenCalledWith('corp');
  });

  it('keeps a theme the user installed themselves', async () => {
    const mine: InstalledTheme = { ...CORP, id: 'mine', managed: false, forceEnabled: false };
    useThemeStore.setState((s) => ({ installedThemes: [...s.installedThemes, mine] }));

    await useThemeStore.getState().syncServerThemes();

    expect(useThemeStore.getState().installedThemes.some((t) => t.id === 'mine')).toBe(true);
  });

  it('leaves everything alone when the server list could not be read', async () => {
    const { apiFetch } = await import('@/lib/browser-navigation');
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('nope', { status: 500 }));

    await useThemeStore.getState().syncServerThemes();

    expect(useThemeStore.getState().installedThemes.some((t) => t.id === 'corp')).toBe(true);
  });
});

describe('server theme sync with skins', () => {
  it('downloads the skin of a v2 theme', async () => {
    useThemeStore.setState((s) => ({ installedThemes: s.installedThemes.filter((t) => t.builtIn), activeThemeId: null }));
    serverThemes.themes = [{ id: 'ocean', name: 'Ocean', version: '1.0.0', author: 'a', description: '', variants: ['light'], forceEnabled: false, hasSkin: true, contentHash: 'h1' }];
    assets['/api/admin/themes/ocean/css'] = ':root{--color-primary:#0066cc}';
    assets['/api/admin/themes/ocean/skin'] = '.message-list{border-radius:8px}';

    await useThemeStore.getState().syncServerThemes();

    const ocean = useThemeStore.getState().installedThemes.find((t) => t.id === 'ocean');
    expect(ocean?.skin).toContain('border-radius');
    expect(pluginStorage.saveThemeSkin).toHaveBeenCalledWith('ocean', expect.stringContaining('border-radius'));
  });

  it('re-downloads a re-upload of the same version', async () => {
    useThemeStore.setState((s) => ({
      installedThemes: [...s.installedThemes.filter((t) => t.builtIn), { ...CORP, id: 'ocean', forceEnabled: false, version: '1.0.0', contentHash: 'h1', css: ':root{--color-primary:red}' }],
      activeThemeId: null,
    }));
    serverThemes.themes = [{ id: 'ocean', name: 'Ocean', version: '1.0.0', author: 'a', description: '', variants: ['light'], forceEnabled: false, hasSkin: false, contentHash: 'h2' }];
    assets['/api/admin/themes/ocean/css'] = ':root{--color-primary:blue}';

    await useThemeStore.getState().syncServerThemes();

    expect(useThemeStore.getState().installedThemes.find((t) => t.id === 'ocean')?.css).toContain('blue');
  });

  it('keeps the skin of an unchanged managed theme on the next load (#1561)', async () => {
    document.getElementById('active-theme-skin')?.remove();
    // As persisted: the skin is stripped from localStorage and kept in IndexedDB.
    useThemeStore.setState((s) => ({
      installedThemes: [...s.installedThemes.filter((t) => t.builtIn), { ...CORP, id: 'ocean', forceEnabled: false, version: '1.0.0', contentHash: 'h1', skin: undefined }],
      activeThemeId: 'ocean',
    }));
    serverThemes.themes = [{ id: 'ocean', name: 'Ocean', version: '1.0.0', author: 'a', description: '', variants: ['light', 'dark'], forceEnabled: false, hasSkin: true, contentHash: 'h1' }];
    vi.mocked(pluginStorage.getThemeSkin).mockResolvedValueOnce('.message-list{border-radius:8px}');

    await useThemeStore.getState().syncServerThemes();

    await vi.waitFor(() => expect(document.getElementById('active-theme-skin')?.textContent).toContain('border-radius'));
  });
});
