import { create } from 'zustand';
import type { SettingsPolicy, FeatureGates, SettingRestriction, ThemePolicy } from '@/lib/admin/types';
import { DEFAULT_POLICY, DEFAULT_THEME_POLICY, POLICY_SCOPE_HEADER } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';
import { IS_LITE, IS_LITE_STALWART, LITE_POLICY_PATH, withLiteBuildId } from '@/lib/lite';
import { applyLitePolicy } from '@/lib/lite-config';

interface PolicyState {
  policy: SettingsPolicy;
  loaded: boolean;
  /**
   * The server answered with the public subset (not signed in yet); the
   * full policy is fetched again once a session exists.
   */
  partial: boolean;
  fetchPolicy: () => Promise<void>;
  /** Fetch the full policy if only the public subset is loaded. */
  refreshIfPartial: () => Promise<void>;
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

let policyRequest = 0;

export const usePolicyStore = create<PolicyState>()((set, get) => ({
  policy: { ...DEFAULT_POLICY },
  loaded: false,
  partial: false,

  fetchPolicy: async () => {
    // A fetch started before signing in may answer after the one started
    // after it; only the latest may land.
    const request = ++policyRequest;
    // Static Lite build: an optional policy.json next to index.html stands in
    // for the admin server; missing means defaults, and the gates that need
    // the server stay pinned off either way (lib/lite-config.ts).
    const fallback = IS_LITE ? { policy: applyLitePolicy({}) } : {};
    try {
      // Stalwart serves bundle files immutably: a build-id URL instead of no-store.
      const res = IS_LITE_STALWART
        ? await apiFetch(withLiteBuildId(LITE_POLICY_PATH))
        : await apiFetch(IS_LITE ? LITE_POLICY_PATH : '/api/admin/policy', IS_LITE ? { cache: 'no-store' } : undefined);
      if (request !== policyRequest) return;
      if (res.ok) {
        const data = await res.json();
        if (request !== policyRequest) return;
        const partial = res.headers?.get?.(POLICY_SCOPE_HEADER) === 'public';
        set({ policy: IS_LITE ? applyLitePolicy(data) : data, loaded: true, partial });
      } else {
        set({ ...fallback, loaded: true });
      }
    } catch {
      if (request === policyRequest) set({ ...fallback, loaded: true });
    }
  },

  refreshIfPartial: async () => {
    if (IS_LITE || (get().loaded && !get().partial)) return;
    await get().fetchPolicy();
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
