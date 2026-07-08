'use client';

import { useEffect, useState } from 'react';
import { useThemeStore } from '@/stores/theme-store';
import { SettingsSection } from './settings-section';
import { cn } from '@/lib/utils';
import { Check, Lock } from 'lucide-react';
import { toast } from '@/stores/toast-store';
import { usePolicyStore } from '@/stores/policy-store';

export function ThemesSettings() {
  const { installedThemes, activeThemeId, activateTheme } = useThemeStore();
  const { isThemeDisabled, getThemePolicy, getForcedThemeId, isThemeForceEnabled } = usePolicyStore();
  const themePolicy = getThemePolicy();
  const forcedThemeId = getForcedThemeId(installedThemes.map((theme) => theme.id));

  // Render each preview in the variant matching the app's current mode, and
  // keep it in sync when the user toggles light/dark elsewhere.
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains('dark'));
    update();
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Filter out themes disabled by admin policy
  const visibleThemes = installedThemes.filter(
    theme => !isThemeDisabled(theme.id, !!theme.builtIn)
  );

  useEffect(() => {
    if (forcedThemeId && activeThemeId !== forcedThemeId) {
      activateTheme(forcedThemeId);
    }
  }, [activeThemeId, activateTheme, forcedThemeId]);

  // If the active theme was disabled by admin, fall back to default
  useEffect(() => {
    if (activeThemeId) {
      const activeTheme = installedThemes.find(t => t.id === activeThemeId);
      if (activeTheme && isThemeDisabled(activeThemeId, !!activeTheme.builtIn)) {
        activateTheme(forcedThemeId ?? null);
      }
    }
  }, [activeThemeId, activateTheme, forcedThemeId, installedThemes, isThemeDisabled]);

  const handleActivate = (id: string | null) => {
    // Clicking the already-active theme is a no-op (no re-apply, no toast).
    if (id === activeThemeId) return;

    if (forcedThemeId && id !== forcedThemeId) {
      const forcedTheme = installedThemes.find((theme) => theme.id === forcedThemeId);
      toast.info(`Theme "${forcedTheme?.name ?? 'Admin theme'}" is forced by admin and cannot be changed`);
      return;
    }

    activateTheme(id);
    toast.success(id ? 'Theme activated' : 'Default theme restored');
  };

  return (
    <SettingsSection title="Themes" description="Choose from themes deployed by your administrator and built-in presets.">

      {forcedThemeId && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
          Theme selection is locked by an administrator.
        </div>
      )}

      {/* Theme Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {/* Default theme card */}
        <ThemeCard
          name="Default"
          author="Bulwark"
          isDefaultTheme
          variants={['light', 'dark']}
          isDark={isDark}
          isActive={activeThemeId === null}
          isBuiltIn
          isDefault={!themePolicy.defaultThemeId}
          disabled={Boolean(forcedThemeId)}
          onActivate={() => handleActivate(null)}
        />

        {/* Installed themes */}
        {visibleThemes.map(theme => {
          const isForceEnabled = theme.id === forcedThemeId || theme.forceEnabled || isThemeForceEnabled(theme.id);
          return (
            <ThemeCard
              key={theme.id}
              name={theme.name}
              author={theme.author}
              preview={theme.preview}
              css={theme.css}
              isDark={isDark}
              isActive={activeThemeId === theme.id}
              isBuiltIn={theme.builtIn}
              isDefault={themePolicy.defaultThemeId === theme.id}
              isForceEnabled={isForceEnabled}
              disabled={Boolean(forcedThemeId) && !isForceEnabled}
              variants={theme.variants}
              onActivate={() => handleActivate(theme.id)}
            />
          );
        })}
      </div>
    </SettingsSection>
  );
}

// ─── Theme Card ──────────────────────────────────────────────

interface ThemeCardProps {
  name: string;
  author: string;
  preview?: string;
  css?: string;
  isDark?: boolean;
  isDefaultTheme?: boolean;
  isActive: boolean;
  isBuiltIn: boolean;
  isDefault?: boolean;
  isForceEnabled?: boolean;
  disabled?: boolean;
  variants?: ('light' | 'dark')[];
  onActivate: () => void;
}

function ThemeCard({ name, author, preview, css, isDark, isDefaultTheme, isActive, isDefault, isForceEnabled, disabled, variants, onActivate }: ThemeCardProps) {
  const colors = resolveThemeColors({ css, variants, isDark: !!isDark, isDefaultTheme: !!isDefaultTheme });
  return (
    <div data-search-label={name} className="relative">
      <button
        type="button"
        onClick={onActivate}
        disabled={disabled}
        className={cn(
          'flex flex-col items-center p-3 rounded-xl border-2 transition-all text-start w-full disabled:cursor-not-allowed disabled:opacity-60',
          isActive
            ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
            : 'border-border hover:border-primary/40 bg-card',
          disabled && !isActive && 'hover:border-border'
        )}
      >
        {/* Preview: marketplace image when shipped, otherwise a mini app
            mockup painted from the theme's own colour tokens. */}
        <div className="w-full aspect-[16/10] rounded-lg mb-2 overflow-hidden bg-muted">
          {preview ? (
            <img src={preview} alt={name} className="w-full h-full object-cover" />
          ) : (
            <ThemePreview colors={colors} />
          )}
        </div>

        {/* Info */}
        <div className="w-full">
          <div className="flex items-center justify-between gap-1">
            <span className="text-sm font-medium text-foreground truncate">{name}</span>
            <div className="flex items-center gap-1 flex-shrink-0">
              {isForceEnabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium flex items-center gap-0.5" title="Admin enforced">
                  <Lock className="w-2.5 h-2.5" />
                </span>
              )}
              {isDefault && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">Default</span>
              )}
              {isActive && <Check className="w-4 h-4 text-primary" />}
            </div>
          </div>
          <span className="text-xs text-muted-foreground truncate block">{author}</span>
          {variants && (
            <div className="flex gap-1 mt-1">
              {variants.map(v => (
                <span key={v} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {v}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>
    </div>
  );
}

// ─── Theme Preview ───────────────────────────────────────────

interface ThemeColors {
  background: string;
  sidebar: string;
  card: string;
  primary: string;
  primaryForeground: string;
  foreground: string;
  mutedForeground: string;
  border: string;
}

// The built-in "Default" theme has no `css` of its own (it's the app's base
// tokens); these mirror app/globals.css so its card previews accurately.
const DEFAULT_LIGHT: ThemeColors = {
  background: '#ffffff', sidebar: '#f8fafc', card: '#ffffff', primary: '#3b82f6',
  primaryForeground: '#ffffff', foreground: '#0f172a', mutedForeground: '#64748b', border: '#e2e8f0',
};
const DEFAULT_DARK: ThemeColors = {
  background: '#0a0a0a', sidebar: '#0a0a0a', card: '#141414', primary: '#fafafa',
  primaryForeground: '#171717', foreground: '#fafafa', mutedForeground: '#a3a3a3', border: '#262626',
};

// Pull a handful of structural colour tokens out of a theme's compiled CSS.
// Themes declare light tokens under `:root { … }` and dark under `.dark { … }`;
// neither block nests braces, so a non-greedy capture is enough.
function extractThemeColors(css: string, dark: boolean): ThemeColors | null {
  const block = css.match(dark ? /\.dark\s*\{([\s\S]*?)\}/ : /:root\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  const body = block[1];
  const get = (name: string): string | undefined => {
    const m = body.match(new RegExp(`--color-${name}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : undefined;
  };
  const background = get('background');
  if (!background) return null;
  return {
    background,
    sidebar: get('sidebar') ?? background,
    card: get('card') ?? background,
    primary: get('primary') ?? '#888888',
    primaryForeground: get('primary-foreground') ?? '#ffffff',
    foreground: get('foreground') ?? '#000000',
    mutedForeground: get('muted-foreground') ?? '#888888',
    border: get('border') ?? 'rgba(128,128,128,0.3)',
  };
}

function resolveThemeColors({ css, variants, isDark, isDefaultTheme }: {
  css?: string;
  variants?: ('light' | 'dark')[];
  isDark: boolean;
  isDefaultTheme: boolean;
}): ThemeColors {
  // Prefer the variant matching the app's current mode; fall back to the one
  // the theme actually ships if it's single-variant.
  const hasLight = !variants || variants.includes('light');
  const hasDark = !variants || variants.includes('dark');
  const wantDark = (isDark && hasDark) || !hasLight;

  if (isDefaultTheme || !css) return wantDark ? DEFAULT_DARK : DEFAULT_LIGHT;
  return (
    extractThemeColors(css, wantDark) ??
    extractThemeColors(css, !wantDark) ??
    (wantDark ? DEFAULT_DARK : DEFAULT_LIGHT)
  );
}

// A miniature of the real three-pane mailbox - icon nav rail, folder sidebar,
// message list (first row selected) and reading pane - painted with the
// theme's own colours, standing in for a screenshot.
function ThemePreview({ colors }: { colors: ThemeColors }) {
  const rail = `1px solid ${colors.border}`;
  return (
    <div className="w-full h-full flex overflow-hidden" style={{ backgroundColor: colors.background }}>
      {/* Icon nav rail */}
      <div
        className="flex flex-col items-center gap-1 py-1.5 shrink-0"
        style={{ width: '9%', backgroundColor: colors.sidebar, borderRight: rail }}
      >
        <div className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: colors.primary }} />
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: colors.mutedForeground, opacity: 0.4 }} />
        ))}
      </div>

      {/* Folder sidebar */}
      <div
        className="flex flex-col gap-1 p-1.5 shrink-0"
        style={{ width: '25%', backgroundColor: colors.sidebar, borderRight: rail }}
      >
        <div className="flex items-center gap-1 mb-0.5">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors.mutedForeground, opacity: 0.5 }} />
          <div className="h-1 rounded-full flex-1" style={{ backgroundColor: colors.foreground, opacity: 0.55 }} />
        </div>
        {[0.8, 0.65, 0.72, 0.5].map((w, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="w-1 h-1 rounded-sm shrink-0" style={{ backgroundColor: colors.mutedForeground, opacity: 0.45 }} />
            <div className="h-1 rounded-full" style={{ width: `${w * 100}%`, backgroundColor: colors.mutedForeground, opacity: 0.4 }} />
          </div>
        ))}
      </div>

      {/* Message list */}
      <div className="flex flex-col shrink-0" style={{ width: '36%', backgroundColor: colors.background, borderRight: rail }}>
        {/* Selected row */}
        <div className="flex items-start gap-1 p-1" style={{ backgroundColor: colors.primary }}>
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors.primaryForeground, opacity: 0.85 }} />
          <div className="flex-1 flex flex-col gap-0.5">
            <div className="h-1 rounded-full" style={{ width: '70%', backgroundColor: colors.primaryForeground, opacity: 0.9 }} />
            <div className="h-1 rounded-full" style={{ width: '90%', backgroundColor: colors.primaryForeground, opacity: 0.55 }} />
          </div>
        </div>
        {/* Unread + read rows */}
        {[0.6, 0.7, 0.55].map((w, i) => (
          <div key={i} className="flex items-start gap-1 p-1" style={{ borderTop: rail }}>
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors.mutedForeground, opacity: 0.4 }} />
            <div className="flex-1 flex flex-col gap-0.5">
              <div className="h-1 rounded-full" style={{ width: `${w * 100}%`, backgroundColor: colors.foreground, opacity: i === 0 ? 0.7 : 0.5 }} />
              <div className="h-1 rounded-full" style={{ width: '85%', backgroundColor: colors.mutedForeground, opacity: 0.35 }} />
            </div>
          </div>
        ))}
      </div>

      {/* Reading pane */}
      <div className="flex-1 flex flex-col gap-1 p-1.5 min-w-0">
        <div className="h-1.5 rounded-full" style={{ width: '70%', backgroundColor: colors.foreground, opacity: 0.85 }} />
        <div className="h-1 rounded-full mb-1" style={{ width: '40%', backgroundColor: colors.mutedForeground, opacity: 0.5 }} />
        {[0.95, 0.85, 0.9, 0.6].map((w, i) => (
          <div key={i} className="h-1 rounded-full" style={{ width: `${w * 100}%`, backgroundColor: colors.mutedForeground, opacity: 0.3 }} />
        ))}
      </div>
    </div>
  );
}
