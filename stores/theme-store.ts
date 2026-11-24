import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { InstalledTheme, ThemeVariant } from '@/lib/plugin-types';
import { pluginStorage } from '@/lib/plugin-storage';
import {
  injectThemeCSS,
  removeThemeCSS,
  sanitizeThemeCSS,
  sanitizeSkinCSS,
  injectThemeSkinCSS,
  removeThemeSkinCSS,
} from '@/lib/theme-loader';
import { BUILTIN_THEMES } from '@/lib/builtin-themes';
import { usePolicyStore } from '@/stores/policy-store';
import { apiFetch } from '@/lib/browser-navigation';
import { fetchServerPluginList } from '@/lib/server-plugin-list';
import { themeHooks } from '@/lib/plugin-hooks';
import { syncThemeColorMeta } from '@/lib/theme-color-meta';
import { IS_LITE, IS_LITE_STALWART, LITE_THEMES_PATH, withLiteBuildId } from '@/lib/lite';

type Theme = 'light' | 'dark' | 'system';

function getForcedThemeId(installedThemes: InstalledTheme[]): string | null {
  const policyForcedThemeId = usePolicyStore
    .getState()
    .getForcedThemeId(installedThemes.map((theme) => theme.id));

  if (policyForcedThemeId) {
    return policyForcedThemeId;
  }

  return installedThemes.find((theme) => theme.forceEnabled)?.id ?? null;
}

/**
 * The mode to use for `theme` (#1280): the theme policy's locked mode
 * whatever the user picked, its default while they have not picked one.
 */
function policyColorMode(theme: Theme, chosen: boolean): Theme {
  const { mode, locked } = usePolicyStore.getState().getColorModePolicy();
  return mode && (locked || !chosen) ? mode : theme;
}

interface ThemeState {
  theme: Theme;
  /**
   * The user picked `theme` themselves (#1280). Until they do, the theme
   * policy's defaultColorMode applies. Synced with the settings.
   */
  themeChosen: boolean;
  resolvedTheme: 'light' | 'dark';
  hydrated: boolean;

  // Custom theme system
  installedThemes: InstalledTheme[];
  activeThemeId: string | null; // null = built-in default
  /**
   * The user picked `activeThemeId` themselves, Default included. Until they
   * do, the theme policy's defaultThemeId applies.
   */
  themeChoiceMade: boolean;

  /** `chosen: false` sets a mode the user did not pick (a synced one they never chose). */
  setTheme: (theme: Theme, opts?: { chosen?: boolean }) => void;
  toggleTheme: () => void;
  initializeTheme: () => void;
  /** Applies the theme policy's color mode; runs whenever the policy changes. */
  applyColorModePolicy: () => void;
  /**
   * Switches to the theme policy's defaultThemeId while the user has not
   * picked a theme. Runs when the policy changes and after the server
   * themes are installed.
   */
  applyThemePolicyDefault: () => void;

  // Custom theme management
  installTheme: (file: File) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  uninstallTheme: (id: string) => void;
  /** `chosen: false` switches without counting it as the user's pick (an admin forcing or disabling a theme). */
  activateTheme: (id: string | null, opts?: { chosen?: boolean }) => void;
  syncServerThemes: () => Promise<void>;
  /**
   * Before signing in (#1846): installs the admin theme the policy names
   * for the sign-in page, the forced or default one, so a browser that
   * never signed in shows it too.
   */
  syncSignInTheme: () => Promise<void>;
}

type PersistedThemeState = Pick<ThemeState, 'theme' | 'themeChosen' | 'activeThemeId' | 'themeChoiceMade' | 'installedThemes'>;

const getSystemTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyTheme = (theme: 'light' | 'dark') => {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.remove('light');
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
    root.classList.add('light');
  }

  // Also update color-scheme for native elements (scrollbars, form controls)
  root.style.colorScheme = theme;

  // Keep the PWA title bar in step with the mode switch (#671).
  syncThemeColorMeta();

  localStorage.setItem('theme-applied', theme);
};

let mediaQueryCleanup: (() => void) | null = null;
let themeSyncPromise: Promise<void> | null = null;
let signInThemePromise: Promise<void> | null = null;

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      themeChosen: false,
      resolvedTheme: 'light',
      hydrated: false,
      installedThemes: [...BUILTIN_THEMES],
      activeThemeId: null,
      themeChoiceMade: false,

      setTheme: (requested, opts) => {
        const themeChosen = opts?.chosen ?? true;
        const theme = policyColorMode(requested, themeChosen);
        const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;
        applyTheme(resolvedTheme);
        set({ theme, resolvedTheme, themeChosen });
        // Re-apply active custom theme for new mode
        const { activeThemeId, installedThemes } = get();
        if (activeThemeId) {
          const t = installedThemes.find(t => t.id === activeThemeId);
          if (t) applyCustomThemeCSS(t, resolvedTheme);
        }
      },

      toggleTheme: () => {
        const { theme } = get();
        const nextTheme: Theme =
          theme === 'light' ? 'dark' :
          theme === 'dark' ? 'system' : 'light';
        get().setTheme(nextTheme);
      },

      applyColorModePolicy: () => {
        const { theme, themeChosen } = get();
        if (policyColorMode(theme, themeChosen) !== theme) get().setTheme(theme, { chosen: themeChosen });
      },

      applyThemePolicyDefault: () => {
        const { hydrated, themeChoiceMade, activeThemeId, installedThemes } = get();
        // Before rehydration the persisted choice is not known yet.
        if (!hydrated || themeChoiceMade) return;
        if (getForcedThemeId(installedThemes)) return;
        const defaultId = usePolicyStore.getState().policy.themePolicy?.defaultThemeId;
        if (!defaultId || activeThemeId === defaultId) return;
        // An admin theme arrives with syncServerThemes, which calls this again.
        const t = installedThemes.find(it => it.id === defaultId);
        if (!t) return;
        if (t.css) {
          set({ activeThemeId: defaultId });
          applyCustomThemeCSS(t, get().resolvedTheme);
          return;
        }
        pluginStorage.getThemeCSS(defaultId).then(css => {
          if (!css || get().themeChoiceMade || get().activeThemeId !== activeThemeId) return;
          const withCss = { ...t, css };
          set(state => ({
            activeThemeId: defaultId,
            installedThemes: state.installedThemes.map(it => it.id === defaultId ? withCss : it),
          }));
          applyCustomThemeCSS(withCss, get().resolvedTheme);
        });
      },

      initializeTheme: () => {
        const { theme, activeThemeId, installedThemes, themeChoiceMade } = get();
        const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;
        applyTheme(resolvedTheme);
        set({ resolvedTheme, hydrated: true });

        // Determine effective theme: forced theme > user choice > policy default > none
        const forcedThemeId = getForcedThemeId(installedThemes);
        let effectiveThemeId = forcedThemeId ?? activeThemeId;
        if (!effectiveThemeId && !themeChoiceMade) {
          const policyState = usePolicyStore.getState();
          const tp = policyState.policy.themePolicy;
          if (tp?.defaultThemeId) {
            effectiveThemeId = tp.defaultThemeId;
          }
        }

        if (effectiveThemeId !== activeThemeId) {
          set({ activeThemeId: effectiveThemeId });
        }

        // No theme in effect: drop the copy the boot script may have put back
        // from the cache (lib/boot-skeleton/boot-script.ts, applyBootTheme).
        if (!effectiveThemeId) {
          removeThemeCSS();
          removeThemeSkinCSS();
        }

        // Apply active custom theme on boot
        if (effectiveThemeId) {
          const t = installedThemes.find(t => t.id === effectiveThemeId);
          if (t) {
            // Load CSS from IndexedDB (may have been stripped from localStorage)
            if (t.css) {
              applyCustomThemeCSS(t, resolvedTheme);
            } else {
              pluginStorage.getThemeCSS(effectiveThemeId).then(css => {
                if (css) {
                  injectThemeCSS(css);
                  // Update the in-memory cache
                  set({
                    installedThemes: installedThemes.map(
                      it => it.id === effectiveThemeId ? { ...it, css } : it
                    ),
                  });
                }
              });
            }
          }
        }

        // Clean up previous listener if any
        if (mediaQueryCleanup) {
          mediaQueryCleanup();
          mediaQueryCleanup = null;
        }

        if (typeof window !== 'undefined') {
          const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
          const handleChange = () => {
            const { theme, activeThemeId, installedThemes } = get();
            if (theme === 'system') {
              const newResolvedTheme = getSystemTheme();
              applyTheme(newResolvedTheme);
              set({ resolvedTheme: newResolvedTheme });
              if (activeThemeId) {
                const t = installedThemes.find(t => t.id === activeThemeId);
                if (t) applyCustomThemeCSS(t, newResolvedTheme);
              }
            }
          };

          mediaQuery.addEventListener('change', handleChange);
          mediaQueryCleanup = () => mediaQuery.removeEventListener('change', handleChange);
        }
      },

      installTheme: async (file: File) => {
        // The package reader (ZIP, manifest checks) loads with the first install, not with the page.
        const { extractTheme } = await import('@/lib/plugin-validator');
        const result = await extractTheme(file);
        if (!result.valid || !result.manifest) {
          return { success: false, error: result.errors.join('; '), warnings: result.warnings };
        }

        const { manifest, css, skin, preview } = result;
        const { installedThemes } = get();

        // Carry advanced (Theme API v2) fields from the manifest through
        // to the InstalledTheme so the activate/sync paths can re-compile
        // or re-apply tokens later if needed.
        const advancedFields = {
          apiVersion: manifest.apiVersion,
          extends: manifest.extends,
          tokens: manifest.tokens,
          derive: manifest.derive,
          density: manifest.density,
          radii: manifest.radii,
          typography: manifest.typography,
        };

        // Check for duplicate
        if (installedThemes.some(t => t.id === manifest.id)) {
          // Update existing
          const sanitized = sanitizeThemeCSS(css);
          const theme: InstalledTheme = {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            description: manifest.description || '',
            preview: preview || undefined,
            css: sanitized.css,
            skin: skin ?? undefined,
            variants: manifest.variants,
            enabled: true,
            builtIn: false,
            ...advancedFields,
          };

          await pluginStorage.saveThemeCSS(manifest.id, sanitized.css);
          if (skin) {
            await pluginStorage.saveThemeSkin(manifest.id, skin);
          } else {
            await pluginStorage.deleteThemeSkin(manifest.id);
          }
          if (preview) await pluginStorage.savePreview(manifest.id, preview);

          set({
            installedThemes: installedThemes.map(t =>
              t.id === manifest.id ? theme : t
            ),
          });

          return { success: true, warnings: [...result.warnings, ...sanitized.warnings] };
        }

        // Install new
        const sanitized = sanitizeThemeCSS(css);
        const theme: InstalledTheme = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          description: manifest.description || '',
          preview: preview || undefined,
          css: sanitized.css,
          skin: skin ?? undefined,
          variants: manifest.variants,
          enabled: true,
          builtIn: false,
          ...advancedFields,
        };

        await pluginStorage.saveThemeCSS(manifest.id, sanitized.css);
        if (skin) await pluginStorage.saveThemeSkin(manifest.id, skin);
        if (preview) await pluginStorage.savePreview(manifest.id, preview);

        set({ installedThemes: [...installedThemes, theme] });
        return { success: true, warnings: [...result.warnings, ...sanitized.warnings] };
      },

      uninstallTheme: (id: string) => {
        const { installedThemes, activeThemeId } = get();
        const theme = installedThemes.find(t => t.id === id);
        if (!theme || theme.builtIn) return;
        const forceEnabledByPolicy = usePolicyStore.getState().isThemeForceEnabled(id);
        if (theme.forceEnabled || forceEnabledByPolicy) return;

        // Deactivate if active
        if (activeThemeId === id) {
          removeThemeCSS();
          removeThemeSkinCSS();
          set({ activeThemeId: null });
        }

        // Clean up storage
        pluginStorage.deleteThemeCSS(id);
        pluginStorage.deleteThemeSkin(id);
        pluginStorage.deletePreview(id);

        set({
          installedThemes: installedThemes.filter(t => t.id !== id),
        });
      },

      activateTheme: (id: string | null, opts) => {
        const { installedThemes, resolvedTheme } = get();
        const themeChoiceMade = (opts?.chosen ?? true) || get().themeChoiceMade;
        const forcedThemeId = getForcedThemeId(installedThemes);

        if (forcedThemeId && id !== forcedThemeId) {
          const forcedTheme = installedThemes.find((theme) => theme.id === forcedThemeId);
          if (forcedTheme) {
            applyCustomThemeCSS(forcedTheme, resolvedTheme);
            set({ activeThemeId: forcedThemeId });
          }
          return;
        }

        if (id === null) {
          removeThemeCSS();
          removeThemeSkinCSS();
          set({ activeThemeId: null, themeChoiceMade });
          return;
        }

        const theme = installedThemes.find(t => t.id === id);
        if (!theme) return;

        if (!theme.css) {
          pluginStorage.getThemeCSS(id).then((css) => {
            if (!css) return;

            const hydratedTheme = { ...theme, css };
            applyCustomThemeCSS(hydratedTheme, get().resolvedTheme);
            set((state) => ({
              activeThemeId: id,
              installedThemes: state.installedThemes.map((item) =>
                item.id === id ? { ...item, css } : item
              ),
            }));
          });
          set({ activeThemeId: id, themeChoiceMade });
          return;
        }

        applyCustomThemeCSS(theme, resolvedTheme);
        set({ activeThemeId: id, themeChoiceMade });
      },

      syncServerThemes: async () => {
        if (themeSyncPromise) {
          await themeSyncPromise;
          return;
        }

        themeSyncPromise = (async () => {
          try {
            // Lite has no admin dashboard: the deployment's own themes are
            // static files next to policy.json (#1582).
            if (IS_LITE) {
              const themes = await fetchLiteThemes();
              if (themes) await applyServerThemes(themes, true);
              return;
            }
            const res = await fetchServerPluginList();
            if (!res.ok) return;

            const data = res.data as { themes: ServerThemeInfo[] };
            if (!data?.themes || !Array.isArray(data.themes)) return;

            await applyServerThemes(data.themes, true);
          } catch {
            console.warn('[theme-store] Server theme sync failed');
          }
        })();

        try {
          await themeSyncPromise;
        } finally {
          themeSyncPromise = null;
        }
      },

      syncSignInTheme: async () => {
        // Lite's themes are public files: the sign-in page gets all of them.
        if (IS_LITE) return get().syncServerThemes();
        if (themeSyncPromise || signInThemePromise) return;
        const signInTheme = usePolicyStore.getState().policy.signInTheme;
        // Only the answer to a visitor carries it; signed in, the full sync runs.
        if (signInTheme === undefined) return;
        signInThemePromise = applyServerThemes(signInTheme ? [signInTheme] : [], false)
          .catch(() => console.warn('[theme-store] Sign-in theme sync failed'));
        try {
          await signInThemePromise;
        } finally {
          signInThemePromise = null;
        }
      },
    }),
    {
      name: 'theme-storage',
      version: 2,
      partialize: (state): PersistedThemeState => ({
        theme: state.theme,
        themeChosen: state.themeChosen,
        activeThemeId: state.activeThemeId,
        themeChoiceMade: state.themeChoiceMade,
        // Store theme metadata but NOT full CSS / skin (those go in IndexedDB)
        installedThemes: state.installedThemes.map(t => ({
          ...t,
          css: t.builtIn ? t.css : '', // only keep CSS for built-in themes
          skin: undefined, // skins also in IndexedDB
          preview: undefined, // previews also in IndexedDB
        })),
      }),
      // v1: themeChosen (#1280). Earlier builds did not record it, so a mode
      // other than the built-in default is taken as chosen.
      // v2: themeChoiceMade (#689). Earlier builds did not record it, so a
      // theme other than Default is taken as chosen.
      migrate: (persisted, version) => {
        const state = persisted as PersistedThemeState;
        if (version < 1) state.themeChosen = state.theme !== 'system';
        if (version < 2) state.themeChoiceMade = !!state.activeThemeId;
        return state;
      },
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            // Ensure built-in themes are always present after rehydration.
            // Drop persisted themes that were flagged builtIn but no longer
            // exist in BUILTIN_THEMES (e.g. a built-in removed from source) so
            // stale built-ins don't survive as phantom "user" themes.
            const builtInIds = new Set(BUILTIN_THEMES.map(t => t.id));
            const userThemes = state.installedThemes.filter(
              t => !builtInIds.has(t.id) && !t.builtIn
            );
            state.installedThemes = [...BUILTIN_THEMES, ...userThemes];

            // If the active theme pointed at a now-removed built-in, fall back
            // to the default so the UI doesn't reference a missing theme.
            if (
              state.activeThemeId &&
              !state.installedThemes.some(t => t.id === state.activeThemeId)
            ) {
              state.activeThemeId = null;
            }

            // Re-apply theme immediately after rehydration
            const resolvedTheme = state.theme === 'system' ? getSystemTheme() : state.theme;
            applyTheme(resolvedTheme);
            state.resolvedTheme = resolvedTheme;
            state.hydrated = true;
          }
        };
      },
    }
  )
);

/**
 * Apply a custom theme's CSS, filtering to the appropriate variant.
 *
 * Fires the `themeHooks.onThemeBeforeApply` transform hook so plugins can
 * post-process the CSS (e.g. inject extra `@font-face` rules or override
 * specific tokens). The hook is fire-and-forget - we inject the original
 * CSS synchronously first to avoid a flash, then re-inject the transformed
 * version once handlers settle.
 *
 * If the theme also has a `skin` (Theme API v2 component-level overrides),
 * it's injected into a separate `<style>` tag after the colour block so
 * skin rules win specificity. The skin is hydrated lazily from IndexedDB
 * on first activation.
 */
function applyCustomThemeCSS(theme: InstalledTheme, resolvedTheme: 'light' | 'dark'): void {
  // If theme only supports one variant and current mode doesn't match, skip
  if (!theme.variants.includes(resolvedTheme as ThemeVariant)) {
    removeThemeCSS();
    removeThemeSkinCSS();
    return;
  }
  injectThemeCSS(theme.css);

  // Apply skin if the theme ships one. Hydrate from IndexedDB if the cached
  // copy was stripped from localStorage on persist.
  if (theme.skin) {
    injectThemeSkinCSS(theme.skin, theme.id);
  } else if (theme.apiVersion === 2 || theme.managed) {
    // Server-synced themes carry no apiVersion, but their skin is kept in
    // IndexedDB too (#1561).
    pluginStorage.getThemeSkin(theme.id).then((skin) => {
      // Bail out if the user switched themes mid-flight.
      if (useThemeStore.getState().activeThemeId !== theme.id) return;
      if (skin) {
        injectThemeSkinCSS(skin, theme.id);
        useThemeStore.setState((state) => ({
          installedThemes: state.installedThemes.map((it) =>
            it.id === theme.id ? { ...it, skin } : it,
          ),
        }));
      } else {
        removeThemeSkinCSS();
      }
    });
  } else {
    removeThemeSkinCSS();
  }

  // Run plugin transforms asynchronously and re-inject if any handler
  // modified the CSS. No handlers → no extra work.
  if (themeHooks.onThemeBeforeApply.size === 0) return;
  const themeId = theme.id;
  themeHooks.onThemeBeforeApply
    .transform(theme.css, { themeId, variant: resolvedTheme })
    .then((transformed) => {
      // Bail out if the user switched themes while we were awaiting handlers.
      if (useThemeStore.getState().activeThemeId !== themeId) return;
      if (transformed && transformed !== theme.css) {
        // A plugin's output gets no more reach than a theme's own CSS.
        injectThemeCSS(sanitizeThemeCSS(transformed).css);
      }
    })
    .catch(() => {
      // Hook failures are tracked by the hook bus; nothing to do here.
    });
}

/**
 * Installs or updates `serverThemes`, then applies a forced theme and the
 * policy's default. `complete` says the list is every theme the server
 * serves (/api/plugins): a managed theme missing from it was removed. The
 * sign-in page knows one theme only (#1846), so it passes false.
 */
async function applyServerThemes(serverThemes: ServerThemeInfo[], complete: boolean): Promise<void> {
  const get = useThemeStore.getState;
  const set = useThemeStore.setState;

  for (const st of serverThemes) {
    const local = get().installedThemes.find(t => t.id === st.id);

    if (!local) {
      // Download and install new server theme
      const css = await downloadThemeAsset(st, 'css');
      if (!css) continue;
      const skin = st.hasSkin ? await downloadThemeAsset(st, 'skin') : null;

      const sanitized = sanitizeThemeCSS(css);
      const sanitizedSkin = skin ? sanitizeSkinCSS(skin).css : undefined;
      const theme: InstalledTheme = {
        id: st.id,
        name: st.name,
        version: st.version,
        author: st.author,
        description: st.description || '',
        css: sanitized.css,
        variants: st.variants as ThemeVariant[],
        enabled: true,
        builtIn: false,
        managed: true,
        forceEnabled: st.forceEnabled,
        contentHash: st.contentHash,
        ...(sanitizedSkin ? { skin: sanitizedSkin } : {}),
      };

      await pluginStorage.saveThemeCSS(st.id, sanitized.css);
      if (sanitizedSkin) await pluginStorage.saveThemeSkin(st.id, sanitizedSkin);
      set(state => {
        if (state.installedThemes.some(t => t.id === st.id)) {
          return {};
        }
        return {
          installedThemes: [...state.installedThemes, theme],
        };
      });
      // The policy default named it before it was installed.
      if (get().activeThemeId === st.id) {
        applyCustomThemeCSS(theme, get().resolvedTheme);
      }

    } else if (!local.builtIn) {
      let css = local.css;
      let skin = local.skin;
      // The hash catches a re-upload of the same version.
      const changed = local.version !== st.version
        || (!!st.contentHash && local.contentHash !== st.contentHash);

      if (changed || !css) {
        const downloadedCss = await downloadThemeAsset(st, 'css');
        if (!downloadedCss) continue;

        const sanitized = sanitizeThemeCSS(downloadedCss);
        css = sanitized.css;
        await pluginStorage.saveThemeCSS(st.id, sanitized.css);
      }
      if (changed) {
        const downloadedSkin = st.hasSkin ? await downloadThemeAsset(st, 'skin') : null;
        skin = downloadedSkin ? sanitizeSkinCSS(downloadedSkin).css : undefined;
        if (skin) await pluginStorage.saveThemeSkin(st.id, skin);
        else await pluginStorage.deleteThemeSkin(st.id);
      }

      const updatedTheme = {
        ...local,
        name: st.name,
        version: st.version,
        author: st.author,
        description: st.description || '',
        css,
        skin,
        variants: st.variants as ThemeVariant[],
        managed: true,
        forceEnabled: st.forceEnabled,
        contentHash: st.contentHash,
      };

      set(state => ({
        installedThemes: state.installedThemes.map(t =>
          t.id === st.id ? updatedTheme : t
        ),
      }));

      // Re-apply if active
      if (get().activeThemeId === st.id) {
        applyCustomThemeCSS(updatedTheme, get().resolvedTheme);
      }
    }
  }

  // A managed theme the server no longer lists was deleted or
  // disabled by the admin. Without this it stayed installed, and
  // its local forceEnabled flag kept forcing it on forever.
  const serverIds = new Set(serverThemes.map(t => t.id));
  const stale = complete ? get().installedThemes.filter(t => t.managed && !t.builtIn && !serverIds.has(t.id)) : [];
  if (!complete) {
    // The sign-in page hears of one theme only, the forced one when there
    // is one: any other managed theme this browser keeps is forced no more.
    set(state => ({
      installedThemes: state.installedThemes.map(t =>
        t.managed && !t.builtIn && t.forceEnabled && !serverIds.has(t.id) ? { ...t, forceEnabled: false } : t
      ),
    }));
  }
  if (stale.length > 0) {
    const staleIds = new Set(stale.map(t => t.id));
    const activeId = get().activeThemeId;
    if (activeId && staleIds.has(activeId)) {
      removeThemeCSS();
      removeThemeSkinCSS();
      set({ activeThemeId: null });
    }
    for (const id of staleIds) {
      void pluginStorage.deleteThemeCSS(id);
      void pluginStorage.deleteThemeSkin(id);
      void pluginStorage.deletePreview(id);
    }
    set(state => ({
      installedThemes: state.installedThemes.filter(t => !staleIds.has(t.id)),
    }));
  }

  set(state => ({
    installedThemes: dedupeInstalledThemes(state.installedThemes),
  }));

  const forcedThemeId = getForcedThemeId(get().installedThemes);
  if (forcedThemeId && get().activeThemeId !== forcedThemeId) {
    const forcedTheme = get().installedThemes.find((theme) => theme.id === forcedThemeId);
    if (forcedTheme) {
      applyCustomThemeCSS(forcedTheme, get().resolvedTheme);
      set({ activeThemeId: forcedThemeId });
    }
  }
  get().applyThemePolicyDefault();
}

// ─── Server Theme Sync Helpers ───────────────────────────────

interface ServerThemeInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  variants: string[];
  forceEnabled: boolean;
  hasSkin?: boolean;
  contentHash?: string;
}

function dedupeInstalledThemes(themes: InstalledTheme[]): InstalledTheme[] {
  const byId = new Map<string, InstalledTheme>();

  for (const theme of themes) {
    const existing = byId.get(theme.id);
    if (!existing) {
      byId.set(theme.id, theme);
      continue;
    }

    byId.set(theme.id, {
      ...existing,
      ...theme,
      builtIn: existing.builtIn || theme.builtIn,
      enabled: existing.enabled || theme.enabled,
      managed: existing.managed || theme.managed,
      forceEnabled: theme.forceEnabled ?? existing.forceEnabled,
    });
  }

  return [...byId.values()];
}

/**
 * The themes of a Lite deployment (#1582): `themes.json` next to policy.json,
 * as `{ "themes": [...] }` in the shape /api/plugins lists them. No file is
 * no themes; a file that can't be read leaves the installed ones as they are
 * (null).
 */
async function fetchLiteThemes(): Promise<ServerThemeInfo[] | null> {
  try {
    // Asked again on each load, as policy.json is (#1563).
    const res = IS_LITE_STALWART
      ? await apiFetch(withLiteBuildId(LITE_THEMES_PATH), { cache: 'no-cache' })
      : await apiFetch(LITE_THEMES_PATH, { cache: 'no-store' });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    return parseLiteThemes(await res.json());
  } catch {
    console.warn('[theme-store] themes.json could not be read');
    return null;
  }
}

const THEME_VARIANTS = ['light', 'dark'];
/** As an extension's id (lib/extension-package.ts), which this store doesn't load. */
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** The well-formed entries of a themes.json; the rest are left out. */
export function parseLiteThemes(data: unknown): ServerThemeInfo[] {
  const list = data && typeof data === 'object' ? (data as { themes?: unknown }).themes : undefined;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ServerThemeInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const name = text(raw.name, 100);
    if (!THEME_ID_RE.test(id) || seen.has(id) || !name) continue;
    seen.add(id);
    const variants = Array.isArray(raw.variants)
      ? raw.variants.filter((v): v is string => typeof v === 'string' && THEME_VARIANTS.includes(v))
      : [];
    out.push({
      id,
      name,
      version: text(raw.version, 40) || '1.0.0',
      author: text(raw.author, 100),
      description: text(raw.description, 500),
      variants: variants.length > 0 ? [...new Set(variants)] : [...THEME_VARIANTS],
      forceEnabled: raw.forceEnabled === true,
      hasSkin: raw.hasSkin === true,
      ...(text(raw.contentHash, 128) ? { contentHash: text(raw.contentHash, 128) } : {}),
    });
  }
  return out;
}

/** Where a theme's file is: the admin's upload, or in Lite the static file. */
function themeAssetUrl(theme: ServerThemeInfo, kind: 'css' | 'skin'): string {
  // The content hash in the URL keeps a browser cache from serving the
  // previous upload.
  const version = theme.contentHash ? `?v=${encodeURIComponent(theme.contentHash)}` : '';
  if (IS_LITE) {
    const path = `/themes/${encodeURIComponent(theme.id)}/${kind === 'css' ? 'theme' : 'skin'}.css`;
    return version ? `${path}${version}` : withLiteBuildId(path);
  }
  return `/api/admin/themes/${encodeURIComponent(theme.id)}/${kind}${version}`;
}

async function downloadThemeAsset(theme: ServerThemeInfo, kind: 'css' | 'skin'): Promise<string | null> {
  try {
    const url = themeAssetUrl(theme, kind);
    // A Lite file without a hash may change under the same build: ask again.
    const res = IS_LITE && !theme.contentHash ? await apiFetch(url, { cache: 'no-cache' }) : await apiFetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    console.warn(`[theme-store] Failed to download ${kind} for theme "${theme.id}"`);
    return null;
  }
}
// The policy arrives after this store has rehydrated (and again in full once
// signed in), so its color mode (#1280) and default theme (#689) apply
// whenever it changes.
usePolicyStore.subscribe((state, prev) => {
  if (state.policy !== prev.policy) {
    useThemeStore.getState().applyColorModePolicy();
    useThemeStore.getState().applyThemePolicyDefault();
    if (state.policy.signInTheme !== undefined || IS_LITE) void useThemeStore.getState().syncSignInTheme();
  }
});

// Plugins hear about every change of scheme or theme, whichever path made it
// (settings, the system switching to dark, a forced admin theme).
useThemeStore.subscribe((state, prev) => {
  if (state.theme !== prev.theme || state.resolvedTheme !== prev.resolvedTheme) {
    void themeHooks.onThemeChange.emit({ theme: state.theme, resolved: state.resolvedTheme });
  }
  if (state.activeThemeId !== prev.activeThemeId) {
    void themeHooks.onCustomThemeChange.emit({ themeId: state.activeThemeId });
  }
});
