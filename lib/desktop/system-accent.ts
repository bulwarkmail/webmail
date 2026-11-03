/**
 * The OS accent colour, when the user's theme is "system". Buttons and selection take
 * it the way native controls do. Not under a theme the user chose, and not when the
 * colour would be hard to see: the app's own stays then.
 */

import { getDesktopBridge } from './bridge';

const VARIABLES = ['--color-primary', '--color-ring', '--color-primary-foreground'] as const;

function channels(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Non-text contrast, WCAG 1.4.11. */
const MIN_AGAINST_BACKGROUND = 3;
const MIN_TEXT = 4.5;

/**
 * The colours to use, or null for the app's own: the accent has to stand out from the
 * page, and text on it has to be readable in either black or white.
 */
export function accentColours(accent: string, dark: boolean): { primary: string; foreground: string } | null {
  const rgb = channels(accent);
  if (!rgb) return null;
  const own = luminance(rgb);
  // The standard theme's page backgrounds.
  const page = dark ? 0.0091 : 1;
  if (contrast(own, page) < MIN_AGAINST_BACKGROUND) return null;
  const onWhite = contrast(own, 1);
  const onBlack = contrast(own, 0);
  if (Math.max(onWhite, onBlack) < MIN_TEXT) return null;
  return { primary: accent, foreground: onWhite >= MIN_TEXT ? '#ffffff' : '#000000' };
}

export interface AccentInput {
  accent?: string;
  /** Whether the page is dark now. */
  dark: boolean;
  /** The user's theme setting is "system" and no installed theme is active. */
  followsSystem: boolean;
  /** A contrast theme has its own colours and they win. */
  highContrast?: boolean;
}

export function applySystemAccent({ accent, dark, followsSystem, highContrast }: AccentInput, root: HTMLElement = document.documentElement): void {
  const colours = accent && followsSystem && !highContrast && getDesktopBridge() ? accentColours(accent, dark) : null;
  if (!colours) {
    for (const name of VARIABLES) root.style.removeProperty(name);
    return;
  }
  root.style.setProperty('--color-primary', colours.primary);
  root.style.setProperty('--color-ring', colours.primary);
  root.style.setProperty('--color-primary-foreground', colours.foreground);
}
