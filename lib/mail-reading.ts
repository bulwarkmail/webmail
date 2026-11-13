/**
 * How the reading settings on Settings > Accessibility reach a message body.
 *
 * HTML mail renders in a sandboxed iframe that the app's stylesheet doesn't
 * reach, so the text size, spacing, colours and motion settings have to be
 * carried into that document: as CSS appended after the mail's own (so it
 * wins the cascade) and, for text size, as a pass over the computed styles
 * after the document parsed. Plain-text bodies sit in the app document and
 * only need their own font size.
 */

import {
  FONT_SIZE_SCALE,
  type AppFont,
  type ContrastMode,
  type FontSize,
  type LetterSpacing,
  type LineSpacing,
  type MailOverrideStyles,
  type ParagraphSpacing,
  type SystemToggle,
  type WordSpacing,
} from '@/lib/accessibility-settings';

/** Size of body text in a message, in CSS px at 100 %: what mail used to be fixed at. */
export const MAIL_BASE_FONT_PX = 14;

/**
 * The factor message text is drawn at: the mail text size, or the app's text
 * size when that is set to follow it (0).
 */
export function mailTextFactor(mailTextScale: number, fontSize: FontSize): number {
  if (mailTextScale > 0) return mailTextScale;
  return FONT_SIZE_SCALE[fontSize] ?? 1;
}

/**
 * CSS font size for a plain-text body in the app document. Its rem already
 * carries the app's text size, so only the part the mail size adds on top of
 * that is multiplied in. The minimum, when set, is a floor in px.
 */
export function plainBodyFontSize(basePx: number, mailTextScale: number, fontSize: FontSize, minPx: number): string {
  const appFactor = FONT_SIZE_SCALE[fontSize] ?? 1;
  const extra = Math.round((mailTextFactor(mailTextScale, fontSize) / appFactor) * 10000) / 10000;
  const rem = Math.round((basePx / 16) * 10000) / 10000;
  const size = extra === 1 ? `${rem}rem` : `calc(${rem}rem * ${extra})`;
  return minPx > 0 ? `max(${size}, ${minPx}px)` : size;
}

/**
 * Widest the message card gets with the reading width at about 80
 * characters: the 80-character column at the mail's text size (a character
 * of the body fonts is about 0.55em, so 44em) and its gutters, 1.25rem a side.
 */
export function readingCardWidth(mailTextScale: number, fontSize: FontSize, minPx: number): string {
  return `calc(${plainBodyFontSize(MAIL_BASE_FONT_PX, mailTextScale, fontSize, minPx)} * 44 + 2.5rem)`;
}

/**
 * One element's text size after scaling by `factor` and raising it to the
 * minimum. A line height in px grows by the same ratio, so the enlarged text
 * doesn't overlap the next line; "normal" (null) needs nothing.
 */
export function scaledTextSize(
  fontPx: number,
  lineHeightPx: number | null,
  { factor, minPx }: { factor: number; minPx: number },
): { font: number; lineHeight: number | null } {
  if (!(fontPx > 0)) return { font: fontPx, lineHeight: lineHeightPx };
  const font = Math.max(fontPx * factor, minPx || 0);
  const ratio = font / fontPx;
  return { font, lineHeight: lineHeightPx === null ? null : lineHeightPx * ratio };
}

/** Elements that draw no text of their own. */
const NO_TEXT = new Set(['IMG', 'BR', 'HR', 'WBR', 'PICTURE', 'SOURCE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'SCRIPT', 'TEMPLATE']);

export interface MailTextSizeOptions {
  /** Multiplier on every text size in the mail. */
  factor: number;
  /** Smallest text size, in CSS px; 0 = no minimum. */
  minPx: number;
  /** Turn justified text into start-aligned text. */
  unjustify?: boolean;
  /** Leave sizes alone (the override stylesheet sets them); only unjustify. */
  sizesFromCss?: boolean;
}

const DONE_ATTR = 'data-bulwark-text-size';

/**
 * Scales the text of a rendered mail document and raises text below the
 * minimum, by reading every element's computed font size and writing the new
 * one back inline. Reads all elements first and writes after, so the pass
 * costs one style recalculation. Once one element changes, every element is
 * pinned to its own px size: a child sized in em would otherwise grow a second
 * time with its parent. Runs once per document; returns whether it changed
 * anything.
 *
 * Text size works on the text rather than zooming the whole mail, so a
 * fixed-width newsletter keeps its width and its text wraps inside it instead
 * of pushing the layout off the side of the pane.
 */
export function applyMailTextSize(doc: Document, options: MailTextSizeOptions): boolean {
  const body = doc.body;
  const view = doc.defaultView;
  if (!body || !view || body.hasAttribute(DONE_ATTR)) return false;
  const factor = options.sizesFromCss ? 1 : options.factor;
  const minPx = options.sizesFromCss ? 0 : options.minPx;
  if (factor === 1 && !(minPx > 0) && !options.unjustify) return false;
  body.setAttribute(DONE_ATTR, '');

  const elements: HTMLElement[] = [body];
  body.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (NO_TEXT.has(el.tagName) || el.closest('svg')) return;
    elements.push(el);
  });

  const writes: Array<() => void> = [];
  const sizes: Array<{ el: HTMLElement; font: number; lineHeight: number | null; changed: boolean }> = [];
  let anySizeChanged = false;
  for (const el of elements) {
    const style = view.getComputedStyle(el);
    if (options.unjustify && style.textAlign === 'justify') {
      writes.push(() => el.style.setProperty('text-align', 'start', 'important'));
    }
    if (factor === 1 && !(minPx > 0)) continue;
    const fontPx = parseFloat(style.fontSize);
    if (!(fontPx > 0)) continue;
    const lineHeightPx = style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight) : null;
    const next = scaledTextSize(fontPx, lineHeightPx, { factor, minPx });
    const changed = Math.abs(next.font - fontPx) > 0.01;
    if (changed) anySizeChanged = true;
    sizes.push({ el, font: next.font, lineHeight: next.lineHeight, changed });
  }
  if (anySizeChanged) {
    for (const { el, font, lineHeight } of sizes) {
      writes.push(() => {
        el.style.setProperty('font-size', `${Math.round(font * 100) / 100}px`, 'important');
        if (lineHeight !== null) el.style.setProperty('line-height', `${Math.round(lineHeight * 100) / 100}px`, 'important');
      });
    }
  }
  for (const write of writes) write();
  return writes.length > 0;
}

/** A "system / on / off" setting resolved against the OS preference. */
export function resolveSystemToggle(value: SystemToggle, systemOn: boolean): boolean {
  return value === 'on' || (value === 'system' && systemOn);
}

/** Whether the mail's own fonts, sizes and colours give way to the app's. */
export function mailOverrideActive(mode: MailOverrideStyles, contrast: ContrastMode, systemMoreContrast: boolean): boolean {
  if (mode === 'always') return true;
  if (mode !== 'high-contrast') return false;
  return contrast === 'more' || (contrast === 'system' && systemMoreContrast);
}

/** The app's look, as the override stylesheet puts it into a mail. */
export interface MailOverrideTheme {
  fontFamily: string;
  foreground: string;
  background: string;
  link: string;
}

export interface MailSpacing {
  lineSpacing: LineSpacing;
  letterSpacing: LetterSpacing;
  wordSpacing: WordSpacing;
  paragraphSpacing: ParagraphSpacing;
}

export type MailOverride = MailOverrideTheme & MailSpacing & { textFactor: number; minPx: number };

export interface MailFrameCssOptions {
  reduceMotion: boolean;
  underlineLinks?: boolean;
  /** Keep lines to about 80 characters. */
  comfortableWidth?: boolean;
  /** Replace the sender's fonts, sizes and colours; null leaves them. */
  override?: MailOverride | null;
  /** @font-face rules the override font needs inside the mail document. */
  fontFaceCss?: string;
}

/** Stops CSS animations and transitions in a mail (reduce motion). */
export const MAIL_REDUCED_MOTION_CSS = '*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;animation-delay:0s!important;transition-duration:0.01ms!important;transition-delay:0s!important;scroll-behavior:auto!important}';

/** Same values the app uses (app/accessibility.css); "normal" is our body default. */
const LINE_HEIGHT: Record<LineSpacing, number> = { normal: 1.6, relaxed: 1.6, loose: 1.9 };
const LETTER_SPACING: Record<LetterSpacing, string | null> = { normal: null, wide: '0.05em', wider: '0.12em' };

/** Strips what could end the declaration, the rule or the <style> element. */
function cssValue(value: string): string {
  return value.replace(/[<>{};\\]/g, '').trim();
}

/** The override stylesheet: the app's font, text size, colours and spacing. */
export function mailOverrideCss(o: MailOverride): string {
  const font = cssValue(o.fontFamily) || 'sans-serif';
  const fg = cssValue(o.foreground) || '#000';
  const bg = cssValue(o.background) || '#fff';
  const link = cssValue(o.link) || fg;
  const size = `calc(${MAIL_BASE_FONT_PX / 16}rem * ${o.textFactor})`;
  const bodySize = o.minPx > 0 ? `max(${size}, ${o.minPx}px)` : size;
  const letter = LETTER_SPACING[o.letterSpacing];
  // Everything that holds text; images and media keep their own look.
  const text = 'body *:not(svg,svg *,img,picture,video,canvas)';
  const parts = [
    // The colour on <html> only: on both, a translucent one (a theme's card
    // colour) would be painted twice.
    `html{background:${bg}!important}body{background:transparent!important}html,body{color:${fg}!important}`,
    `body{font-family:${font}!important;font-size:${bodySize}!important;line-height:${LINE_HEIGHT[o.lineSpacing]}!important}`,
    // Sizes follow the body, headings keep a step above it.
    `${text}{font-family:inherit!important;font-size:1em!important;line-height:inherit!important;color:${fg}!important;background-color:transparent!important;background-image:none!important;text-shadow:none!important}`,
    'h1{font-size:1.6em!important}h2{font-size:1.4em!important}h3{font-size:1.2em!important}h4,h5,h6{font-size:1.05em!important}',
    o.minPx > 0 ? `small,sub,sup{font-size:max(0.85em,${o.minPx}px)!important}` : 'small,sub,sup{font-size:0.85em!important}',
    // Underlined too: with the backgrounds gone, a link drawn as a button
    // would otherwise look like plain text.
    `a[href],a[href] *{color:${link}!important}`,
    'a[href]{text-decoration-line:underline!important}',
    // Never justified (the text pass catches justify from <style> rules).
    '[align="justify"],[style*="justify"]{text-align:start!important}',
  ];
  if (letter) parts.push(`${text}{letter-spacing:${letter}!important}`);
  if (o.wordSpacing === 'wide') parts.push(`${text}{word-spacing:0.16em!important}`);
  if (o.paragraphSpacing === 'wide') parts.push('body p{margin-block-end:1.5em!important}');
  return parts.join('\n');
}

/**
 * CSS for the reading settings, appended to the mail document after the
 * mail's own content so it outranks the sender's <style> at equal weight.
 * Empty when no setting asks for anything.
 */
export function mailFrameCss(options: MailFrameCssOptions): string {
  const parts: string[] = [];
  if (options.fontFaceCss) parts.push(options.fontFaceCss);
  if (options.reduceMotion) parts.push(MAIL_REDUCED_MOTION_CSS);
  if (options.underlineLinks) parts.push('a[href]{text-decoration-line:underline!important}');
  if (options.comfortableWidth) parts.push('body{max-width:80ch!important;margin-inline:auto!important}');
  if (options.override) parts.push(mailOverrideCss(options.override));
  return parts.join('\n');
}

/** The @font-face family an app font is bundled under (app/accessibility.css), or null for the default. */
export function appFontFamilyName(font: AppFont): string | null {
  switch (font) {
    case 'atkinson': return 'Atkinson Hyperlegible Next';
    case 'lexend': return 'Lexend';
    case 'opendyslexic': return 'OpenDyslexic';
    default: return null;
  }
}

/**
 * The app's @font-face rules for `family` with their URLs made absolute, and
 * the folders those URLs live in (for the mail document's font-src), so the
 * mail can use the same bundled font. Empty when the rules can't be read.
 */
export function collectFontFaces(doc: Document, family: string): { css: string; sources: string[] } {
  const css: string[] = [];
  const sources = new Set<string>();
  const wanted = family.toLowerCase();
  const visit = (list: CSSRuleList, base: string) => {
    for (const rule of Array.from(list)) {
      const face = rule as CSSFontFaceRule;
      if (face.style && rule.cssText.trimStart().toLowerCase().startsWith('@font-face')) {
        const name = face.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase();
        if (name !== wanted) continue;
        css.push(rule.cssText.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (match, _q, url: string) => {
          try {
            const absolute = new URL(url, base);
            if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return match;
            sources.add(new URL('.', absolute).href);
            return `url("${absolute.href}")`;
          } catch {
            return match;
          }
        }));
      } else if ((rule as CSSGroupingRule).cssRules) {
        visit((rule as CSSGroupingRule).cssRules, base);
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules, sheet.href || doc.baseURI);
    } catch {
      // A cross-origin sheet can't be read.
    }
  }
  return { css: css.join('\n'), sources: [...sources] };
}

/**
 * Scale-to-fit options for a message body: on a phone always (the reader's
 * old behaviour), on any screen with "Fit wide mail" on.
 */
export function mailFitOptions(isMobile: boolean, fitWidth: boolean): { enabled: boolean; viewportMax?: number } {
  return fitWidth ? { enabled: true, viewportMax: Infinity } : { enabled: isMobile };
}
