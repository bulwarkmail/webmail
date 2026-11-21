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
import { DEFAULT_POLICY, DEFAULT_THEME_POLICY, type ThemePolicy } from '@/lib/admin/types';

// #689: the policy loads after the theme store has started, so its default
// theme never reached a user who had not picked one.

const NORD = 'builtin-nord';

function loadThemePolicy(patch: Partial<ThemePolicy>) {
  usePolicyStore.setState({
    policy: { ...DEFAULT_POLICY, themePolicy: { ...DEFAULT_THEME_POLICY, ...patch } },
    loaded: true,
  });
}

const theme = () => useThemeStore.getState();

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

describe('default theme policy (#689)', () => {
  it('applies the default when the policy loads after start-up', () => {
    loadThemePolicy({ defaultThemeId: NORD });
    expect(theme().activeThemeId).toBe(NORD);
    expect(theme().themeChoiceMade).toBe(false);
  });

  it('keeps Default when the user picked it', () => {
    theme().activateTheme(null);
    loadThemePolicy({ defaultThemeId: NORD });
    expect(theme().activeThemeId).toBeNull();
  });

  it('keeps a theme the user picked', () => {
    theme().activateTheme('builtin-qui');
    loadThemePolicy({ defaultThemeId: NORD });
    expect(theme().activeThemeId).toBe('builtin-qui');
  });

  it('follows the operator changing a default the user never touched', () => {
    loadThemePolicy({ defaultThemeId: NORD });
    loadThemePolicy({ defaultThemeId: 'builtin-qui' });
    expect(theme().activeThemeId).toBe('builtin-qui');
  });

  it('does not count a switch made for the admin as the user\'s pick', () => {
    theme().activateTheme(null, { chosen: false });
    loadThemePolicy({ defaultThemeId: NORD });
    expect(theme().activeThemeId).toBe(NORD);
  });

  it('applies an admin theme as default once the server themes are installed', async () => {
    loadThemePolicy({ defaultThemeId: 'corp' });
    expect(theme().activeThemeId).toBeNull();

    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/plugins') {
        return respond({
          plugins: [],
          themes: [{ id: 'corp', name: 'Corp', version: '1.0.0', author: 'IT', variants: ['light', 'dark'], hasSkin: false }],
        });
      }
      if (url.startsWith('/api/admin/themes/corp/css')) {
        return respond(null, { text: ':root { --color-primary: 1 2 3; } .dark { --color-primary: 1 2 3; }' });
      }
      return respond(null, { ok: false, status: 404 });
    });
    await theme().syncServerThemes();

    expect(theme().installedThemes.some((t) => t.id === 'corp')).toBe(true);
    expect(theme().activeThemeId).toBe('corp');
  });
});

describe('theme settings stored before #689', () => {
  it.each([
    [NORD, true],
    [null, false],
  ])('takes a stored theme %s as chosen: %s', async (stored, chosen) => {
    localStorage.setItem('theme-storage', JSON.stringify({
      state: { theme: 'system', themeChosen: false, activeThemeId: stored, installedThemes: [] },
      version: 1,
    }));
    await useThemeStore.persist.rehydrate();
    expect(theme().themeChoiceMade).toBe(chosen);
  });
});
