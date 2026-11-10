/**
 * The options on Settings > Accessibility: their types, defaults and allowed
 * values, and how the visual ones reach the page.
 *
 * Most of them are written onto <html> as data attributes and custom
 * properties by applyAccessibilityTo(); app/accessibility.css does the rest.
 * A "system" value writes nothing, so the CSS falls through to the matching
 * media query (prefers-reduced-motion, prefers-contrast, ...), and the OS
 * setting applies without any script.
 */

/** Text size, as a multiplier on the browser's own default size. */
export type FontSize = 'small' | 'medium' | 'large' | 'x-large' | 'xx-large' | 'xxx-large' | 'huge';
export const FONT_SIZES: readonly FontSize[] = ['small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'huge'];
export const FONT_SIZE_SCALE: Record<FontSize, number> = {
  small: 0.875,
  medium: 1,
  large: 1.125,
  'x-large': 1.25,
  'xx-large': 1.5,
  'xxx-large': 1.75,
  huge: 2,
};

/** Follow the operating system, or override it either way. */
export type SystemToggle = 'system' | 'on' | 'off';
export type ContrastMode = 'system' | 'more' | 'normal';
export type FocusRing = 'off' | 'normal' | 'thick' | 'extra';
export type AppFont = 'default' | 'atkinson' | 'lexend' | 'opendyslexic';
export type LineSpacing = 'normal' | 'relaxed' | 'loose';
export type LetterSpacing = 'normal' | 'wide' | 'wider';
export type WordSpacing = 'normal' | 'wide';
export type ParagraphSpacing = 'normal' | 'wide';
export type ReadingWidth = 'full' | 'comfortable';
export type UnreadCountStyle = 'count' | 'dot' | 'hidden';
export type MailOverrideStyles = 'never' | 'high-contrast' | 'always';
export type MailViewMode = 'html' | 'plain';
/**
 * How long toasts stay, in seconds. 0 keeps them until they are closed, which
 * is the longest of all; see toastDurationAtLeast().
 */
export type ToastDuration = 0 | 5 | 10 | 20 | 60;
export const TOAST_DURATIONS: readonly ToastDuration[] = [5, 10, 20, 60, 0];
/** Message body text size; 0 follows the interface text size. */
export const MAIL_TEXT_SCALES = [0, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2] as const;
export type MailTextScale = (typeof MAIL_TEXT_SCALES)[number];
/** Smallest font size a message body may use, in CSS px; 0 = no minimum. */
export const MAIL_MIN_FONT_SIZES = [0, 12, 14, 16, 18] as const;
export type MailMinFontSize = (typeof MAIL_MIN_FONT_SIZES)[number];
export const READ_ALOUD_RATES = [0.75, 1, 1.25, 1.5] as const;
export type ReadAloudRate = (typeof READ_ALOUD_RATES)[number];

export interface AccessibilitySettings {
  // Colour and contrast
  contrast: ContrastMode;
  reduceTransparency: SystemToggle;
  underlineLinks: boolean;
  showColorNames: boolean;
  colorBlindPalette: boolean;
  // Text and reading
  appFont: AppFont;
  lineSpacing: LineSpacing;
  letterSpacing: LetterSpacing;
  wordSpacing: WordSpacing;
  paragraphSpacing: ParagraphSpacing;
  readingWidth: ReadingWidth;
  readingMask: boolean;
  // Motion
  reduceMotion: SystemToggle;
  pauseAnimatedImages: SystemToggle;
  // Keyboard, pointer and touch
  focusRing: FocusRing;
  focusAlwaysVisible: boolean;
  singleKeyShortcuts: boolean;
  largeTargets: SystemToggle;
  largeCursor: boolean;
  openOnHover: boolean;
  showRowActionButton: boolean;
  nativeScrollbars: boolean;
  // Mail content
  mailViewMode: MailViewMode;
  mailTextScale: MailTextScale;
  mailMinFontSize: MailMinFontSize;
  mailOverrideStyles: MailOverrideStyles;
  mailFitWidth: boolean;
  readAloudRate: ReadAloudRate;
  readAloudVoice: string;
  composeFontFamily: string;
  composeFontSize: string;
  // Notifications, timing and distractions
  toastDuration: ToastDuration;
  confirmDelete: boolean;
  confirmArchive: boolean;
  visualAlerts: boolean;
  unreadCountStyle: UnreadCountStyle;
  doNotDisturb: boolean;
  // Screen readers
  announceNewMail: boolean;
  announceRowPreview: boolean;
  simpleMode: boolean;
  simpleModePagedList: boolean;
  // The quick panel
  showAccessibilityButton: boolean;
}

export const ACCESSIBILITY_DEFAULTS: AccessibilitySettings = {
  contrast: 'system',
  reduceTransparency: 'system',
  underlineLinks: false,
  showColorNames: false,
  colorBlindPalette: false,
  appFont: 'default',
  lineSpacing: 'normal',
  letterSpacing: 'normal',
  wordSpacing: 'normal',
  paragraphSpacing: 'normal',
  readingWidth: 'full',
  readingMask: false,
  reduceMotion: 'system',
  pauseAnimatedImages: 'system',
  // Off: most people use a pointer and find a box round every field they
  // click into distracting. Whoever works by keyboard turns it on in the
  // settings or the accessibility panel (Alt+Shift+A), which keeps its outline.
  focusRing: 'off',
  focusAlwaysVisible: false,
  singleKeyShortcuts: true,
  largeTargets: 'system',
  largeCursor: false,
  openOnHover: true,
  showRowActionButton: false,
  nativeScrollbars: false,
  mailViewMode: 'html',
  mailTextScale: 0,
  mailMinFontSize: 0,
  mailOverrideStyles: 'never',
  mailFitWidth: false,
  readAloudRate: 1,
  readAloudVoice: '',
  composeFontFamily: '',
  composeFontSize: '',
  toastDuration: 5,
  confirmDelete: false,
  confirmArchive: false,
  visualAlerts: false,
  unreadCountStyle: 'count',
  doNotDisturb: false,
  announceNewMail: true,
  announceRowPreview: false,
  simpleMode: false,
  simpleModePagedList: false,
  showAccessibilityButton: false,
};

export const ACCESSIBILITY_KEYS = Object.keys(ACCESSIBILITY_DEFAULTS) as (keyof AccessibilitySettings)[];

const SYSTEM_TOGGLE = ['system', 'on', 'off'] as const;

/**
 * The values each enum or number setting accepts. Imports, sync and admin
 * presets go through this, so a hand-written policy.json or an old export
 * can't put a value on the page that the CSS doesn't know.
 */
export const ACCESSIBILITY_ALLOWED: Partial<Record<string, readonly unknown[]>> = {
  fontSize: FONT_SIZES,
  contrast: ['system', 'more', 'normal'],
  reduceTransparency: SYSTEM_TOGGLE,
  appFont: ['default', 'atkinson', 'lexend', 'opendyslexic'],
  lineSpacing: ['normal', 'relaxed', 'loose'],
  letterSpacing: ['normal', 'wide', 'wider'],
  wordSpacing: ['normal', 'wide'],
  paragraphSpacing: ['normal', 'wide'],
  readingWidth: ['full', 'comfortable'],
  reduceMotion: SYSTEM_TOGGLE,
  pauseAnimatedImages: SYSTEM_TOGGLE,
  focusRing: ['off', 'normal', 'thick', 'extra'],
  largeTargets: SYSTEM_TOGGLE,
  mailViewMode: ['html', 'plain'],
  mailTextScale: MAIL_TEXT_SCALES,
  mailMinFontSize: MAIL_MIN_FONT_SIZES,
  mailOverrideStyles: ['never', 'high-contrast', 'always'],
  readAloudRate: READ_ALOUD_RATES,
  toastDuration: TOAST_DURATIONS,
  unreadCountStyle: ['count', 'dot', 'hidden'],
};

/** True when `value` is one the setting accepts (always true for free-form keys). */
export function isAllowedAccessibilityValue(key: string, value: unknown): boolean {
  const allowed = ACCESSIBILITY_ALLOWED[key];
  return !allowed || allowed.includes(value);
}

/**
 * Settings an admin may preset but never lock: locking text size, contrast,
 * motion, fonts or reading aids can leave someone unable to use the app.
 * A lock on one of these in policy.json is applied as a default instead.
 */
export const UNLOCKABLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'fontSize', 'reduceMotion', 'contrast', 'reduceTransparency', 'underlineLinks', 'showColorNames', 'colorBlindPalette',
  'appFont', 'lineSpacing', 'letterSpacing', 'wordSpacing', 'paragraphSpacing', 'readingWidth', 'readingMask',
  'pauseAnimatedImages', 'focusRing', 'focusAlwaysVisible', 'largeTargets', 'largeCursor',
  'openOnHover', 'showRowActionButton', 'nativeScrollbars', 'mailViewMode', 'mailTextScale', 'mailMinFontSize',
  'mailOverrideStyles', 'mailFitWidth', 'readAloudRate', 'readAloudVoice', 'visualAlerts', 'unreadCountStyle',
  'doNotDisturb', 'announceNewMail', 'announceRowPreview', 'simpleMode', 'simpleModePagedList', 'showAccessibilityButton',
  'plainTextFont', 'emailAlwaysLightMode', 'showToolbarLabels',
]);

/**
 * A toast duration that keeps toasts at least `min` seconds. 0 means "until
 * closed", which satisfies any minimum.
 */
export function toastDurationAtLeast(value: number, min: number): boolean {
  return value === 0 || value >= min;
}

/** What applyAccessibilityTo() reads. */
export type AccessibilityDomState = Pick<AccessibilitySettings,
  'contrast' | 'reduceTransparency' | 'underlineLinks' | 'appFont' | 'lineSpacing' | 'letterSpacing' | 'wordSpacing'
  | 'paragraphSpacing' | 'readingWidth' | 'reduceMotion' | 'focusRing' | 'focusAlwaysVisible' | 'largeTargets'
  | 'largeCursor' | 'nativeScrollbars' | 'simpleMode' | 'unreadCountStyle' | 'colorBlindPalette' | 'showColorNames'
> & { fontSize: FontSize };

/**
 * Writes the visual accessibility settings onto `root` (normally <html>).
 *
 * This function is also stringified into the boot script in
 * app/(main)/layout.tsx, which runs it before the first paint so the page
 * never flashes at the wrong size or contrast. It must therefore stay
 * self-contained: no imports, no module constants, nothing from outside
 * its own body. lib/__tests__/accessibility-settings.test.ts checks that.
 */
export function applyAccessibilityTo(root: HTMLElement, s: Partial<AccessibilityDomState>): void {
  const scale: Record<string, number> = {
    small: 0.875, medium: 1, large: 1.125, 'x-large': 1.25, 'xx-large': 1.5, 'xxx-large': 1.75, huge: 2,
  };
  const set = (name: string, value: string | false | undefined | null) => {
    if (value) root.setAttribute('data-' + name, value);
    else root.removeAttribute('data-' + name);
  };
  const factor = scale[s.fontSize as string] || 1;
  // A percentage, so it multiplies the browser's own default size instead
  // of replacing it.
  root.style.setProperty('--font-size-base', factor * 100 + '%');
  set('contrast', s.contrast === 'more' || s.contrast === 'normal' ? s.contrast : null);
  set('transparency', s.reduceTransparency === 'on' ? 'reduce' : s.reduceTransparency === 'off' ? 'full' : null);
  set('motion', s.reduceMotion === 'on' ? 'reduce' : s.reduceMotion === 'off' ? 'full' : null);
  // The older attribute other code and plugins may still look for.
  set('animations', s.reduceMotion === 'on' ? 'off' : null);
  set('underline-links', s.underlineLinks ? 'on' : null);
  set('app-font', s.appFont && s.appFont !== 'default' ? s.appFont : null);
  set('line-spacing', s.lineSpacing && s.lineSpacing !== 'normal' ? s.lineSpacing : null);
  set('letter-spacing', s.letterSpacing && s.letterSpacing !== 'normal' ? s.letterSpacing : null);
  set('word-spacing', s.wordSpacing && s.wordSpacing !== 'normal' ? s.wordSpacing : null);
  set('paragraph-spacing', s.paragraphSpacing && s.paragraphSpacing !== 'normal' ? s.paragraphSpacing : null);
  set('reading-width', s.readingWidth === 'comfortable' ? 'comfortable' : null);
  set('focus-ring', s.focusRing && s.focusRing !== 'normal' ? s.focusRing : null);
  set('focus-always', s.focusAlwaysVisible ? 'on' : null);
  set('large-targets', s.largeTargets === 'on' ? 'on' : s.largeTargets === 'off' ? 'off' : null);
  set('large-cursor', s.largeCursor ? 'on' : null);
  set('native-scrollbars', s.nativeScrollbars ? 'on' : null);
  set('simple-mode', s.simpleMode ? 'on' : null);
  set('unread-counts', s.unreadCountStyle && s.unreadCountStyle !== 'count' ? s.unreadCountStyle : null);
  set('cvd-palette', s.colorBlindPalette ? 'on' : null);
  set('color-names', s.showColorNames ? 'on' : null);
}

/**
 * The boot script's part: reads the persisted settings and applies them
 * before React loads. Kept as a string because it runs inline in <head>.
 */
export function accessibilityBootScript(): string {
  return `try{var a11y=JSON.parse(localStorage.getItem('settings-storage')||'null');if(a11y&&a11y.state){(${applyAccessibilityTo.toString()})(document.documentElement,a11y.state);}}catch(e){}`;
}
