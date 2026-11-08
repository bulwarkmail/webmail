/**
 * Short questions in a window of their own, in the desktop app: the shell draws a card
 * like the in-page dialog in a frameless window, modal to this one (dialogs.show,
 * src/main/dialog-window.ts in the desktop repo). The page sends its look along, so the
 * window has the app's theme, accent, font and corners.
 *
 * Only for confirm/alert-sized questions: a title, a few lines of plain text and up to
 * four buttons. Anything with fields, pickers or rich content stays in the page. Without
 * the bridge (browser, Lite, an older shell) `askInWindow` returns null and the caller
 * shows its in-page dialog.
 */

import { getDesktopBridge } from './bridge';
import type { DesktopDialogWindowAnswer, DesktopDialogWindowColour, DesktopDialogWindowRequest, DesktopDialogWindowTheme } from './types';

export type WindowQuestion = Omit<DesktopDialogWindowRequest, 'id' | 'theme' | 'lang' | 'dir' | 'message'> & {
  /** Plain text. With `boldMarks`, text between ** pairs is bold, as plugin dialogs have it. */
  message?: string;
  boldMarks?: boolean;
};

/** `failed`: the shell refused the request; show the dialog in the page instead. */
export type WindowAnswer = DesktopDialogWindowAnswer | 'failed';

export interface AskedInWindow {
  answer: Promise<WindowAnswer>;
  /** Takes the question back: the state it belonged to went. Does nothing once answered. */
  cancel: () => void;
}

type ShowBridge = Required<Pick<NonNullable<NonNullable<ReturnType<typeof getDesktopBridge>>['dialogs']>, 'show' | 'cancel'>>;

function showBridge(): ShowBridge | null {
  const dialogs = getDesktopBridge()?.dialogs;
  return dialogs && typeof dialogs.show === 'function' && typeof dialogs.cancel === 'function' ? (dialogs as ShowBridge) : null;
}

export function dialogWindowsAvailable(): boolean {
  return showBridge() !== null;
}

/** Text in runs, with ** pairs bold (plugin-dialog-host.tsx's renderMessage, as runs). */
export function messageRuns(text: string | undefined, boldMarks = false): { text: string; bold?: boolean }[] {
  if (!text) return [];
  if (!boldMarks) return [{ text }];
  return text.split('**').flatMap((part, i) => (part ? [i % 2 === 1 ? { text: part, bold: true } : { text: part }] : []));
}

const COLOUR_VARS: Record<DesktopDialogWindowColour, string> = {
  background: '--color-background',
  foreground: '--color-foreground',
  muted: '--color-muted',
  mutedForeground: '--color-muted-foreground',
  border: '--color-border',
  input: '--color-input',
  primary: '--color-primary',
  primaryForeground: '--color-primary-foreground',
  destructive: '--color-destructive',
  destructiveForeground: '--color-destructive-foreground',
  accent: '--color-accent',
  accentForeground: '--color-accent-foreground',
  ring: '--color-ring',
};

/** What Chromium computes an sRGB colour to. */
const RGB = /^rgba?\((\d{1,3}), (\d{1,3}), (\d{1,3})(?:, ([\d.]+))?\)$/;

/**
 * One colour as rgb()/rgba(), whatever the theme wrote it as (hex, hsl, oklch, color-mix).
 * Each on an element of its own: Electron 45 on Windows keeps an element's first computed
 * colour, so a shared one gave every colour the first's, white text on a white card.
 */
function resolveColour(container: HTMLElement, value: string): string | undefined {
  const probe = document.createElement('div');
  probe.style.color = value;
  if (!probe.style.color) return undefined;
  container.append(probe);
  const computed = getComputedStyle(probe).color.trim();
  probe.remove();
  const rgb = RGB.exec(computed);
  if (rgb) {
    const [r, g, b, a] = rgb.slice(1).map((n) => (n === undefined ? undefined : Number(n)));
    return a === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
  }
  // A wide-gamut form (oklch, color(srgb …)): a canvas gives its sRGB bytes.
  try {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.fillStyle = computed;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  } catch {
    return undefined;
  }
}

function pixels(value: string): number | undefined {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The page's look as it is now: the current theme, dark or light, accent, font and corners. */
export function readDialogTheme(): DesktopDialogWindowTheme {
  if (typeof document === 'undefined') return {};
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  // Inside the page, so the theme's own rules for dialogs and buttons apply to it too.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none';
  const card = document.createElement('div');
  card.className = 'rounded-lg';
  const button = document.createElement('div');
  button.className = 'rounded-md';
  probe.append(card, button);
  document.body.append(probe);
  try {
    const colours: Partial<Record<DesktopDialogWindowColour, string>> = {};
    for (const [key, name] of Object.entries(COLOUR_VARS) as [DesktopDialogWindowColour, string][]) {
      const value = styles.getPropertyValue(name).trim();
      const colour = value ? resolveColour(probe, value) : undefined;
      if (colour) colours[key] = colour;
    }
    return {
      dark: root.classList.contains('dark'),
      colours,
      font: getComputedStyle(document.body).fontFamily || undefined,
      fontSize: pixels(styles.fontSize),
      radius: pixels(getComputedStyle(card).borderTopLeftRadius),
      radiusSmall: pixels(getComputedStyle(button).borderTopLeftRadius),
    };
  } finally {
    probe.remove();
  }
}

let next = 0;

/**
 * Asks in a window of the app's own. Null when this shell can't (the browser, an older
 * shell): show the in-page dialog then.
 */
export function askInWindow(question: WindowQuestion): AskedInWindow | null {
  const bridge = showBridge();
  if (!bridge) return null;
  const { message, boldMarks, ...rest } = question;
  next += 1;
  const id = `dialog-${next}-${Math.random().toString(36).slice(2, 8)}`;
  const request: DesktopDialogWindowRequest = {
    ...rest,
    id,
    message: messageRuns(message, boldMarks),
    theme: readDialogTheme(),
    lang: document.documentElement.lang || undefined,
    dir: document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr',
  };
  let settled = false;
  let answer: Promise<WindowAnswer>;
  try {
    answer = bridge.show(request).then(
      (value) => value ?? null,
      () => 'failed' as const,
    );
  } catch {
    answer = Promise.resolve('failed');
  }
  answer = answer.then((value) => {
    settled = true;
    return value;
  });
  return {
    answer,
    cancel: () => {
      if (!settled) bridge.cancel(id);
    },
  };
}
