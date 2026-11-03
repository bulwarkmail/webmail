import { getDesktopBridge } from '@/lib/desktop/bridge';

/**
 * Keeps <meta name="theme-color"> in step with the active theme.
 *
 * Chromium colours an installed desktop PWA's title bar from this meta tag in
 * preference to the manifest's `theme_color` (#671). The tag is server-rendered
 * from the admin `pwaThemeColor` branding key, but that is a single static
 * value: it can't follow the user's light/dark choice or an installed theme
 * extension, both of which live entirely client-side.
 *
 * So when no explicit `pwaThemeColor` is configured, the root layout mounts
 * <ThemeColorSync /> which calls `enableThemeColorSync()`, and every point that
 * can change the page background - the light/dark class flip and theme/skin CSS
 * injection - calls `syncThemeColorMeta()`. When an admin HAS configured a
 * colour, the component is never mounted, `enabled` stays false, and all of
 * those calls are no-ops so the configured value stands.
 */

const META_SELECTOR = 'meta[name="theme-color"]';
/** rgba() with zero alpha, i.e. an unpainted background we can't derive a colour from. */
const TRANSPARENT = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/;

let enabled = false;
let scheduled = false;

/**
 * Read the colour the page actually paints. `body` carries
 * `background-color: var(--color-background)`, and getComputedStyle resolves it
 * to an `rgb()`/`rgba()` string - so this works no matter how a theme authored
 * the token (hex, oklch, nested var()) and needs no knowledge of theme
 * internals.
 */
function readBackgroundColor(): string | null {
  const el = document.body ?? document.documentElement;
  if (!el) return null;

  const color = getComputedStyle(el).backgroundColor;
  if (!color || color === 'transparent' || TRANSPARENT.test(color)) return null;
  return color;
}

function writeMeta(): void {
  const color = readBackgroundColor();
  if (!color) return;

  let meta = document.head?.querySelector<HTMLMetaElement>(META_SELECTOR);
  if (!meta) {
    if (!document.head) return;
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }

  if (meta.content !== color) meta.content = color;
}

/**
 * Update the meta tag to match the current background, coalescing bursts (a
 * theme switch flips the class AND re-injects CSS) into a single read on the
 * next frame, after the new styles have applied.
 */
export function syncThemeColorMeta(): void {
  if (!enabled || typeof document === 'undefined') return;
  if (scheduled) return;

  scheduled = true;
  const run = () => {
    scheduled = false;
    writeMeta();
    tellDesktopShell();
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 0);
  }
}

/** The desktop app's title bar buttons and new windows' first frame follow the page. */
function tellDesktopShell(): void {
  const theme = getDesktopBridge()?.theme;
  if (!theme) return;
  const background = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;
  if (!background) return;
  theme.set({ dark: document.documentElement.classList.contains('dark'), background });
}

/** Turn syncing on and take a first reading. Called by <ThemeColorSync />. */
export function enableThemeColorSync(): void {
  enabled = true;
  syncThemeColorMeta();
}

/** Test seam - restores the module to its pre-enable state. */
export function resetThemeColorSyncForTests(): void {
  enabled = false;
  scheduled = false;
}
