import { create } from 'zustand';
import type { SettingsPolicy, FeatureGates, SettingRestriction, ThemePolicy } from '@/lib/admin/types';
import { DEFAULT_POLICY, DEFAULT_THEME_POLICY } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';

interface PolicyState {
  policy: SettingsPolicy;
  loaded: boolean;
  fetchPolicy: () => Promise<void>;
  isSettingLocked: (key: string) => boolean;
  isSettingHidden: (key: string) => boolean;
  isFeatureEnabled: (feature: keyof FeatureGates) => boolean;
  getRestriction: (key: string) => SettingRestriction | undefined;
  getEffectiveDefault: (key: string) => unknown;
  getThemePolicy: () => ThemePolicy;
  getForcedThemeId: (availableThemeIds?: string[]) => string | null;
  isThemeDisabled: (themeId: string, isBuiltIn: boolean) => boolean;
  isPluginForceEnabled: (pluginId: string) => boolean;
  isPluginApproved: (pluginId: string) => boolean;
  isThemeForceEnabled: (themeId: string) => boolean;
}

export const usePolicyStore = create<PolicyState>()((set, get) => ({
  policy: { ...DEFAULT_POLICY },
  loaded: false,

  fetchPolicy: async () => {
    try {
      const res = await apiFetch('/api/admin/policy');
      if (res.ok) {
        const data = await res.json();
        set({ policy: data, loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  isSettingLocked: (key) => {
    const r = get().policy.restrictions[key];
    return r?.locked === true;
  },

  isSettingHidden: (key) => {
    const r = get().policy.restrictions[key];
    return r?.hidden === true;
  },

  isFeatureEnabled: (feature) => {
    return get().policy.features[feature] ?? true;
  },

  getRestriction: (key) => {
    return get().policy.restrictions[key];
  },

  getEffectiveDefault: (key) => {
    return get().policy.defaults[key];
  },

  getThemePolicy: () => {
    return get().policy.themePolicy || { ...DEFAULT_THEME_POLICY };
  },

  getForcedThemeId: (availableThemeIds) => {
    const forceEnabledThemes = get().policy.forceEnabledThemes || [];
    if (!availableThemeIds || availableThemeIds.length === 0) {
      return forceEnabledThemes[0] || null;
    }

    const available = new Set(availableThemeIds);
    return forceEnabledThemes.find((themeId) => available.has(themeId)) || null;
  },

  isThemeDisabled: (themeId, isBuiltIn) => {
    const tp = get().policy.themePolicy || DEFAULT_THEME_POLICY;
    if (isBuiltIn) {
      return (tp.disabledBuiltinThemes || []).includes(themeId);
    }
    return (tp.disabledThemes || []).includes(themeId);
  },

  isPluginForceEnabled: (pluginId) => {
    return (get().policy.forceEnabledPlugins || []).includes(pluginId);
  },

  isPluginApproved: (pluginId) => {
    return (get().policy.approvedPlugins || []).includes(pluginId);
  },

  isThemeForceEnabled: (themeId) => {
    return (get().policy.forceEnabledThemes || []).includes(themeId);
  },
}));
