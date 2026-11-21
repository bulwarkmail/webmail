import type { KeywordColor } from '@/stores/settings-store';

/**
 * Custom tag colours: a tag's `color` is a KEYWORD_PALETTE key or a
 * lowercase `#rrggbb` the user typed or picked in Settings > Tags.
 */

const STORED_HEX = /^#[0-9a-f]{6}$/;

/**
 * A colour code as typed or pasted: `#rrggbb`, `rrggbb`, `#rgb` or `rgb`,
 * any case, spaces around it ignored. Returns lowercase `#rrggbb`, or null.
 */
export function parseHexColor(input: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return '#' + (digits.length === 3 ? digits.split('').map((d) => d + d).join('') : digits);
}

/** True for a stored custom colour: lowercase `#rrggbb`. */
export function isHexTagColor(value: string): boolean {
  return STORED_HEX.test(value);
}

const STYLE_SELECTOR = 'style[data-tag-hex-colors]';
const injected = new Set<string>();

/** The CSS for one colour's classes, following the palette's look (KEYWORD_PALETTE). */
function rulesFor(hex: string): string {
  const name = `tag-hex-${hex.slice(1)}`;
  const tint = `color-mix(in srgb, ${hex} 10%, transparent)`;
  return [
    `.${name}-dot{background-color:${hex}}`,
    `.${name}-icon{color:${hex}}`,
    // As tag-fill-* (app/globals.css): opaque over the page background, so
    // the lozenge doesn't take on an unread, selected or hovered row's colour.
    `.${name}-fill{background-color:var(--color-background);background-image:linear-gradient(${tint},${tint})}`,
    // Solid rather than the palette's /30: at 30% a light colour such as
    // #ffff00 leaves no visible outline.
    `.${name}-border{border-color:${hex}}`,
    // Any colour can be picked, so none can be trusted as text: the text
    // colour, as CVD_CLASSES does.
    `.${name}-text{color:var(--color-foreground)}`,
    `.${name}-rowtint{background-color:${tint}}`,
  ].join('\n');
}

/**
 * Adds the rules for `hex` to the page once, in one `<style data-tag-hex-colors>`
 * in the head. In the utilities layer, so they meet the palette's Tailwind
 * classes on equal terms. Does nothing on the server.
 */
function ensureRules(hex: string): void {
  if (typeof document === 'undefined') return;
  let style = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR);
  if (!style) {
    // A new document (or a removed element) holds none of the earlier rules.
    injected.clear();
    style = document.createElement('style');
    style.setAttribute('data-tag-hex-colors', '');
    document.head.appendChild(style);
  }
  if (injected.has(hex)) return;
  injected.add(hex);
  style.appendChild(document.createTextNode(`@layer utilities{\n${rulesFor(hex)}\n}\n`));
}

/**
 * Classes that draw a tag in a custom `#rrggbb`. They are class strings like
 * the palette's, so every caller of tagColor works unchanged; the names are
 * safe in a selector because they only hold hex digits.
 */
export function hexKeywordColor(hex: string): KeywordColor {
  ensureRules(hex);
  const name = `tag-hex-${hex.slice(1)}`;
  return {
    dot: `${name}-dot`,
    icon: `${name}-icon`,
    fill: `${name}-fill`,
    border: `${name}-border`,
    text: `${name}-text`,
    rowTint: `${name}-rowtint`,
  };
}
