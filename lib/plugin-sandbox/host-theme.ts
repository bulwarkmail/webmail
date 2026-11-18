// Theme bridge for plugin slot iframes.
//
// Slot iframes run with an opaque ("null") origin, so they can't load the
// host's globals.css or web fonts cross-origin (see sandbox-document.ts).
// The result: plugin slot UIs fall back to the UA default serif font and have
// no knowledge of the host's light/dark (or custom) theme.
//
// To fix that without any cross-origin asset fetch, the host snapshots the
// *resolved* theme — the computed `--color-*` token values, the resolved
// font-family (which is a pure system-font stack, so no fetch is needed), and
// whether dark mode is active — and ships it across the postMessage bridge.
// The sandbox runtime replays the snapshot as an injected <style> block plus a
// `.dark` class, so every plugin slot inherits the app font and can react to
// theme changes by reading `var(--color-*)`.

/** A replayable description of the host's currently resolved theme. */
export interface ThemeSnapshot {
  /** Whether the host has dark mode active (`.dark` on <html>). */
  dark: boolean;
  /** Resolved font-family stack (system fonts only — safe to replay verbatim). */
  fontFamily: string;
  /** Resolved values for each mirrored CSS custom property. */
  vars: Record<string, string>;
}

// CSS custom properties mirrored into plugin slots. Kept in sync with the
// `:root` token block in app/globals.css. Both the colour tokens (the stable
// theming API surface) and the tier-2 typography/density tokens are included so
// plugins can match the host's metrics, not just its colours.
const THEME_TOKENS: readonly string[] = [
  '--color-border',
  '--color-input',
  '--color-ring',
  '--color-background',
  '--color-foreground',
  '--color-primary',
  '--color-primary-foreground',
  '--color-secondary',
  '--color-secondary-foreground',
  '--color-muted',
  '--color-muted-foreground',
  '--color-accent',
  '--color-accent-foreground',
  '--color-destructive',
  '--color-destructive-foreground',
  '--color-popover',
  '--color-popover-foreground',
  '--color-sidebar',
  '--color-sidebar-foreground',
  '--color-sidebar-border',
  '--color-sidebar-accent',
  '--color-sidebar-accent-foreground',
  '--color-card',
  '--color-card-foreground',
  '--color-success',
  '--color-success-foreground',
  '--color-warning',
  '--color-warning-foreground',
  '--color-info',
  '--color-info-foreground',
  '--color-selection',
  '--color-selection-foreground',
  '--color-unread',
  '--color-list-section',
  '--color-list-section-foreground',
  '--color-chart-1',
  '--color-chart-2',
  '--color-chart-3',
  '--color-chart-4',
  '--color-chart-5',
  '--font-size-base',
  '--list-item-height',
  '--transition-duration',
  '--density-item-py',
  '--density-item-gap',
  '--density-header-py',
  '--density-card-p',
  '--density-sidebar-py',
  '--touch-row-min-h',
];

// Mirrors the body font stack in app/globals.css. Used when no document is
// available (SSR) or the body has no resolvable font-family yet.
const FALLBACK_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif';

/**
 * Read the host's resolved theme off `<html>`. Reading computed styles means
 * the snapshot automatically reflects the active built-in *and* custom theme,
 * not just the static globals.css defaults.
 */
export function snapshotHostTheme(): ThemeSnapshot {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return { dark: false, fontFamily: FALLBACK_FONT_FAMILY, vars: {} };
  }
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = computed.getPropertyValue(token).trim();
    if (value) vars[token] = value;
  }
  const bodyFont = document.body ? getComputedStyle(document.body).fontFamily : '';
  return {
    dark: root.classList.contains('dark'),
    fontFamily: bodyFont || FALLBACK_FONT_FAMILY,
    vars,
  };
}

/**
 * Build the CSS the sandbox injects to replay a snapshot. Pure (no DOM access)
 * so it can run inside the iframe runtime. The `:root` block restores the
 * host's token values; the `html, body` block gives plugin slots the app font
 * and a theme-aware default text colour with a transparent background (the
 * host's themed container shows through).
 */
export function themeSnapshotToCSS(snapshot: ThemeSnapshot): string {
  const declarations = Object.entries(snapshot.vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  const colorScheme = snapshot.dark ? 'dark' : 'light';
  return [
    ':root {',
    declarations,
    `  color-scheme: ${colorScheme};`,
    // The user's font size setting, so rem units in a slot match the app.
    ...(snapshot.vars['--font-size-base'] ? ['  font-size: var(--font-size-base);'] : []),
    '}',
    'html, body {',
    `  font-family: ${snapshot.fontFamily};`,
    '  color: var(--color-foreground, inherit);',
    '  background: transparent;',
    '}',
  ].join('\n');
}
