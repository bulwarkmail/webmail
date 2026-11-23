import { beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ themes: [] as Record<string, unknown>[] }));
vi.mock('../plugin-registry', () => ({ getThemeRegistry: async () => registry }));

import { signInThemeFor } from '../sign-in-theme';
import { DEFAULT_POLICY, DEFAULT_THEME_POLICY, type SettingsPolicy } from '../types';

// #1846: the theme the sign-in page of a browser that never signed in shows.

const theme = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, version: '1.0.0', author: 'IT', description: '', variants: ['light'],
  enabled: true, installedAt: '', updatedAt: '', contentHash: `hash-${id}`, ...extra,
});

const policy = (patch: Partial<SettingsPolicy> = {}, defaultThemeId: string | null = null): SettingsPolicy => ({
  ...DEFAULT_POLICY, ...patch, themePolicy: { ...DEFAULT_THEME_POLICY, defaultThemeId },
});

beforeEach(() => {
  registry.themes = [theme('corp'), theme('brand', { forceEnabled: true, hasSkin: true }), theme('off', { enabled: false })];
});

describe('signInThemeFor', () => {
  it('names the theme switched on for everyone, over the default', async () => {
    expect(await signInThemeFor(policy({}, 'corp'))).toEqual({
      id: 'brand', name: 'brand', version: '1.0.0', author: 'IT', description: '', variants: ['light'],
      forceEnabled: true, hasSkin: true, contentHash: 'hash-brand',
    });
  });

  it('names a theme the policy forces first', async () => {
    expect((await signInThemeFor(policy({ forceEnabledThemes: ['corp'] })))?.id).toBe('corp');
  });

  it('names the default theme when none is forced', async () => {
    registry.themes = [theme('corp')];
    expect(await signInThemeFor(policy({}, 'corp'))).toMatchObject({ id: 'corp', forceEnabled: false, hasSkin: false });
  });

  it('names nothing for a built-in default, a disabled theme, or no theme', async () => {
    registry.themes = [theme('corp'), theme('off', { enabled: false, forceEnabled: true })];
    expect(await signInThemeFor(policy({}, 'builtin-nord'))).toBeNull();
    expect(await signInThemeFor(policy({}, 'off'))).toBeNull();
    expect(await signInThemeFor(policy())).toBeNull();
  });
});
