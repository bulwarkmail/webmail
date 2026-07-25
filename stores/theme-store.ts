import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { InstalledTheme, ThemeVariant } from '@/lib/plugin-types';
import { pluginStorage } from '@/lib/plugin-storage';
import {
  injectThemeCSS,
  removeThemeCSS,
  sanitizeThemeCSS,
  injectThemeSkinCSS,
  removeThemeSkinCSS,
} from '@/lib/theme-loader';
import { extractTheme } from '@/lib/plugin-validator';
import { BUILTIN_THEMES } from '@/lib/builtin-themes';
import { usePolicyStore } from '@/stores/policy-store';
import { apiFetch } from '@/lib/browser-navigation';
import { themeHooks } from '@/lib/plugin-hooks';

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

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  hydrated: boolean;

  // Custom theme system
  installedThemes: InstalledTheme[];
  activeThemeId: string | null; // null = built-in default
  // Whether the user has ever explicitly picked a theme (including "Default")
  // via activateTheme(). Distinguishes "chose Default on purpose" from "never
  // decided yet" - both look like activeThemeId === null - so the admin's
  // policy default can be applied to the latter without stomping the former.
  themeChoiceMade: boolean;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  initializeTheme: () => void;

  // Custom theme management
  installTheme: (file: File) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  uninstallTheme: (id: string) => void;
  activateTheme: (id: string | null) => void;
  syncServerThemes: () => Promise<void>;
}

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

  localStorage.setItem('theme-applied', theme);
};

let mediaQueryCleanup: (() => void) | null = null;
let themeSyncPromise: Promise<void> | null = null;

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      resolvedTheme: 'light',
      hydrated: false,
      installedThemes: [...BUILTIN_THEMES],
      activeThemeId: null,
      themeChoiceMade: false,

      setTheme: (theme) => {
        const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;
        applyTheme(resolvedTheme);
        set({ theme, resolvedTheme });
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

        // The admin's policy default (themePolicy.defaultThemeId) almost
        // always loses the race above: /api/admin/policy is only fetched
        // after /api/config resolves (see hooks/use-config.ts), so a
        // brand-new user (activeThemeId still null, themeChoiceMade still
        // false) boots into the built-in look every time, and that "no
        // theme" state then gets persisted, making it permanent instead of
        // self-correcting on the next load. Re-check once policy actually
        // arrives, but only if the user still hasn't made their own choice
        // in the meantime.
        const applyPolicyDefaultIfPending = () => {
          if (get().themeChoiceMade) return;
          const current = get().installedThemes;
          if (getForcedThemeId(current)) return;
          const defaultId = usePolicyStore.getState().policy.themePolicy?.defaultThemeId;
          if (!defaultId || get().activeThemeId === defaultId) return;
          const t = current.find(it => it.id === defaultId);
          if (!t) return;
          if (t.css) {
            applyCustomThemeCSS(t, get().resolvedTheme);
            set({ activeThemeId: defaultId });
          } else {
            pluginStorage.getThemeCSS(defaultId).then(css => {
              if (!css || get().themeChoiceMade) return;
              const hydrated = { ...t, css };
              applyCustomThemeCSS(hydrated, get().resolvedTheme);
              set(state => ({
                activeThemeId: defaultId,
                installedThemes: state.installedThemes.map(it => it.id === defaultId ? hydrated : it),
              }));
            });
          }
        };

        if (usePolicyStore.getState().loaded) {
          applyPolicyDefaultIfPending();
        } else {
          const unsubscribe = usePolicyStore.subscribe((state) => {
            if (!state.loaded) return;
            unsubscribe();
            applyPolicyDefaultIfPending();
          });
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

      activateTheme: (id: string | null) => {
        const { installedThemes, resolvedTheme } = get();
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
          set({ activeThemeId: null, themeChoiceMade: true });
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
          set({ activeThemeId: id, themeChoiceMade: true });
          return;
        }

        applyCustomThemeCSS(theme, resolvedTheme);
        set({ activeThemeId: id, themeChoiceMade: true });
      },

      syncServerThemes: async () => {
        if (themeSyncPromise) {
          await themeSyncPromise;
          return;
        }

        themeSyncPromise = (async () => {
          try {
            const res = await apiFetch('/api/plugins');
            if (!res.ok) return;

            const data: { themes: ServerThemeInfo[] } = await res.json();
            if (!data.themes || !Array.isArray(data.themes)) return;

            const serverThemes = data.themes;

            for (const st of serverThemes) {
              const local = get().installedThemes.find(t => t.id === st.id);

              if (!local) {
                // Download and install new server theme
                const css = await downloadThemeCSS(st.id);
                if (!css) continue;

                const sanitized = sanitizeThemeCSS(css);
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
                };

                await pluginStorage.saveThemeCSS(st.id, sanitized.css);
                set(state => {
                  if (state.installedThemes.some(t => t.id === st.id)) {
                    return {};
                  }
                  return {
                    installedThemes: [...state.installedThemes, theme],
                  };
                });

              } else if (!local.builtIn) {
                let css = local.css;

                if (local.version !== st.version || !css) {
                  const downloadedCss = await downloadThemeCSS(st.id);
                  if (!downloadedCss) continue;

                  const sanitized = sanitizeThemeCSS(downloadedCss);
                  css = sanitized.css;
                  await pluginStorage.saveThemeCSS(st.id, sanitized.css);
                }

                const updatedTheme = {
                  ...local,
                  name: st.name,
                  version: st.version,
                  author: st.author,
                  description: st.description || '',
                  css,
                  variants: st.variants as ThemeVariant[],
                  managed: true,
                  forceEnabled: st.forceEnabled,
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
    }),
    {
      name: 'theme-storage',
      partialize: (state) => ({
        theme: state.theme,
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
  } else if (theme.apiVersion === 2) {
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
        injectThemeCSS(transformed);
      }
    })
    .catch(() => {
      // Hook failures are tracked by the hook bus; nothing to do here.
    });
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

async function downloadThemeCSS(themeId: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/admin/themes/${encodeURIComponent(themeId)}/css`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    console.warn(`[theme-store] Failed to download CSS for theme "${themeId}"`);
    return null;
  }
}