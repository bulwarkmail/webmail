/**
 * Dark mode for HTML email bodies rendered in a viewer iframe.
 *
 * Instead of inverting the whole body with a CSS filter (which turns brand
 * red into pink, flips photos that then need re-inverting, and depends on
 * which background attributes survived the external-content blocker), the
 * rendered document is read back through getComputedStyle and its colours are
 * rewritten in place:
 *
 * - Light backgrounds are darkened with their hue kept. Vivid colours (brand
 *   buttons, banners) and backgrounds that are already dark stay as sent.
 * - Text and borders only change when they lack contrast against the new
 *   background; they are then lightened (or darkened) in their own hue.
 * - Images are never touched. An element painted with a background image keeps
 *   its colours, and so does the text drawn straight on it: the sender
 *   designed the two to be read together.
 *
 * Because the pass works on computed styles, colours from inline styles,
 * legacy attributes (bgcolor, <font color>) and <style> blocks are all handled
 * the same way, whether or not remote content is loaded.
 */

/** Whether the email ships its own dark styles. */
export function emailHasNativeDarkMode(html: string): boolean {
  return /prefers-color-scheme\s*:\s*dark/i.test(html);
}

/**
 * `color-scheme` for the iframe element and its root. A mail with its own
 * dark styles gets `dark`, so its `prefers-color-scheme: dark` rules apply
 * whenever the app shows it dark - not only when the OS is dark too, which is
 * what `light dark` would mean.
 */
export function emailColorScheme(isDark: boolean, nativeDarkMode: boolean): 'light' | 'dark' {
  return isDark && nativeDarkMode ? 'dark' : 'light';
}

const ALWAYS = '(min-width: 0px)';
const NEVER = '(max-width: 0.001px)';

/**
 * Pins the mail's `prefers-color-scheme` media queries to the theme the app
 * shows it in. Inside the iframe they would follow the OS, not the app: a
 * light app on a dark OS would render the mail's dark variant, and the app's
 * dark mode on a light OS would never trigger it. Only <style> blocks are
 * rewritten.
 */
export function resolveColorSchemeMedia(html: string, isDark: boolean): string {
  if (!/prefers-color-scheme/i.test(html)) return html;
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) =>
    open + css.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_q, scheme: string) =>
      (scheme.toLowerCase() === 'dark') === isDark ? ALWAYS : NEVER) + close);
}

/** Canvas the converted mail sits on (white maps to this). */
export const EMAIL_DARK_BACKGROUND = '#141414';
const DARK_TEXT = '#e6e6e6';
const DARK_LINK = '#8ab4f8';

/** Class on <html> that keeps the body hidden until the pass has run. */
export const DARK_PENDING_CLASS = 'bulwark-dark-pending';

/**
 * Stylesheet for the srcdoc head in dark mode. Sets the fallback colours for
 * mails that set none, and hides the body until {@link applyEmailDarkMode}
 * ran so the light original never flashes. The canvas is pinned too while
 * pending: a mail that paints <html> itself (`html { background: #fff }`)
 * would otherwise show as a white box until the pass. The reveal animation
 * is a failsafe: the body shows after a moment even if the pass never runs.
 */
export function emailDarkModeCss(): string {
  return `
      html { background: ${EMAIL_DARK_BACKGROUND}; }
      body { color: ${DARK_TEXT}; background: ${EMAIL_DARK_BACKGROUND}; }
      a { color: ${DARK_LINK}; }
      @keyframes bulwark-dark-reveal { to { visibility: visible; } }
      html.${DARK_PENDING_CLASS} { background-color: ${EMAIL_DARK_BACKGROUND} !important; }
      html.${DARK_PENDING_CLASS} body { visibility: hidden; animation: bulwark-dark-reveal 0s 1.5s forwards; }
    `;
}

// ---------------------------------------------------------------------------
// Colour math (sRGB <-> OKLab/OKLCH, WCAG contrast)

export interface Rgba { r: number; g: number; b: number; a: number }
interface Lch { l: number; c: number; h: number }

/** Parses the `rgb()` / `rgba()` forms getComputedStyle returns. */
export function parseComputedColor(value: string): Rgba | null {
  const m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!m) return null;
  let a = 1;
  if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

export function formatColor({ r, g, b, a }: Rgba): string {
  const R = Math.round(r), G = Math.round(g), B = Math.round(b);
  return a >= 1 ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${+a.toFixed(3)})`;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
};

function toLch({ r, g, b }: Rgba): Lch {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

function lchToLinear({ l: L, c, h }: Lch): [number, number, number] {
  const A = c * Math.cos(h), B = c * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH back to sRGB, pulling chroma in until the colour fits the gamut. */
function fromLch(lch: Lch, a: number): Rgba {
  let c = lch.c;
  let lin = lchToLinear({ ...lch, c });
  for (let i = 0; i < 24 && lin.some((v) => v < -1e-4 || v > 1 + 1e-4); i++) {
    c *= 0.9;
    lin = lchToLinear({ ...lch, c });
  }
  const [r, g, b] = lin.map((v) => Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))));
  return { r, g, b, a };
}

function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(x: Rgba, y: Rgba): number {
  const lx = luminance(x), ly = luminance(y);
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}

function sameColor(x: Rgba, y: Rgba): boolean {
  return Math.round(x.r) === Math.round(y.r) && Math.round(x.g) === Math.round(y.g) && Math.round(x.b) === Math.round(y.b) && x.a === y.a;
}

/** Paints a translucent colour over an opaque one. */
function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
    a: 1,
  };
}

/** Lightness white lands on, and the bottom of the "already dark" range. */
const BG_WHITE_L = 0.2;
const BG_DARK_L = 0.45;
/** Chroma from which a background counts as a deliberate, vivid colour. */
const VIVID_CHROMA = 0.1;

/**
 * Dark counterpart of a background colour. Light colours are mirrored into
 * the dark range (white → the dark canvas, light grey → a little lighter, so
 * the mail's card/canvas layering survives), mid greys move down to meet that
 * range, and vivid or already-dark colours are left alone.
 */
export function darkenBackground(color: Rgba): Rgba {
  if (color.a === 0) return color;
  const lch = toLch(color);
  if (lch.l <= BG_DARK_L) return color;
  if (lch.c >= VIVID_CHROMA) return color;
  let l: number;
  if (lch.l >= 0.7) {
    // 1.0 → 0.2, 0.7 → 0.38
    l = BG_WHITE_L + (1 - lch.l) * 0.6;
  } else {
    // 0.45 (kept) … 0.7 (→ 0.38): fold mid greys into the dark range.
    l = BG_DARK_L - ((lch.l - BG_DARK_L) / (0.7 - BG_DARK_L)) * (BG_DARK_L - 0.38);
  }
  return fromLch({ l, c: lch.c, h: lch.h }, color.a);
}

/**
 * Returns `color` if it already reads against `bg`, otherwise a colour of the
 * same hue moved away from the background's lightness until it reaches
 * `minRatio`. Dark text on a dark background is mirrored first (black → near
 * white, dark grey → light grey), which keeps the sender's hierarchy of
 * text greys instead of flattening them all to one value.
 */
export function ensureContrast(color: Rgba, bg: Rgba, minRatio: number): Rgba {
  if (color.a === 0) return color;
  const opaque = color.a < 1 ? composite(color, bg) : color;
  if (contrastRatio(opaque, bg) >= minRatio) return color;
  const lch = toLch(opaque);
  const bgL = toLch(bg).l;
  const lighten = bgL < 0.6;
  let l = lighten ? Math.max(lch.l, 0.96 - lch.l * 0.5) : Math.min(lch.l, 0.3);
  let out = fromLch({ ...lch, l }, 1);
  for (let i = 0; i < 40 && contrastRatio(out, bg) < minRatio; i++) {
    l = lighten ? Math.min(1, l + 0.02) : Math.max(0, l - 0.02);
    out = fromLch({ ...lch, l }, 1);
    if (l === 0 || l === 1) break;
  }
  return out;
}

/**
 * Raises `color`'s lightness in its own hue until it reaches `minRatio`
 * against the darker `bg`. Unlike {@link ensureContrast} it never mirrors a
 * dark colour to a light one, so the frame of a dark card stays a dark frame.
 */
function liftToContrast(color: Rgba, bg: Rgba, minRatio: number): Rgba {
  if (color.a === 0) return color;
  const opaque = color.a < 1 ? composite(color, bg) : color;
  if (contrastRatio(opaque, bg) >= minRatio) return color;
  const lch = toLch(opaque);
  let l = lch.l;
  let out = opaque;
  for (let i = 0; i < 50 && l < 1 && contrastRatio(out, bg) < minRatio; i++) {
    l = Math.min(1, l + 0.02);
    out = fromLch({ ...lch, l }, 1);
  }
  return out;
}

/** Rewrites every `rgb()`/`rgba()` in a computed gradient. */
function mapGradientColors(value: string, map: (c: Rgba) => Rgba): string {
  return value.replace(/rgba?\([^)]*\)/gi, (m) => {
    const c = parseComputedColor(m);
    return c ? formatColor(map(c)) : m;
  });
}

// ---------------------------------------------------------------------------
// The DOM pass

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const SKIP_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'SOURCE', 'svg', 'SVG', 'STYLE', 'SCRIPT', 'BR', 'WBR', 'HEAD', 'TITLE', 'META', 'LINK']);

/** True for a background-image that actually paints a picture. */
function hasImage(backgroundImage: string): boolean {
  if (!backgroundImage || backgroundImage === 'none') return false;
  // The blocker rewrites remote urls to url() (computed as url("")); those
  // paint nothing.
  return /url\(/i.test(backgroundImage.replace(/url\(\s*(?:""|''|)\s*\)/gi, ''));
}

interface Snapshot {
  el: HTMLElement;
  color: Rgba | null;
  bg: Rgba | null;
  bgImage: string;
  borders: (Rgba | null)[];
}

interface Surface {
  /** Opaque colour behind the element's content after conversion. */
  bg: Rgba;
  /** The same colour as the sender painted it. */
  original: Rgba;
  /** Content sits on a background image: leave its colours as sent. */
  onImage: boolean;
}

/**
 * Lifts a kept dark fill that stood out from its light surroundings (a
 * near-black button on a white card) but now sinks into the darkened
 * surface around it. A fill with a border of its own (a dark card, an HTML
 * signature) keeps its colour: the border separates it (see liftToContrast),
 * and lifting the fill would turn the sender's dark design grey.
 */
function keepSeparation(next: Rgba, original: Rgba, parent: Surface, framed: boolean): Rgba {
  if (framed || next !== original || original.a < 0.9) return next;
  if (contrastRatio(original, parent.original) < 3) return next;
  const target = 1.8;
  if (contrastRatio(next, parent.bg) >= target) return next;
  const lch = toLch(next);
  const parentL = toLch(parent.bg).l;
  let l = Math.max(lch.l, parentL);
  let out = next;
  for (let i = 0; i < 25 && contrastRatio(out, parent.bg) < target; i++) {
    l += 0.02;
    out = fromLch({ ...lch, l }, next.a);
  }
  return out;
}

export interface EmailDarkModeOptions {
  /**
   * The user allowed remote content for this message. Only then may a remote
   * image be fetched a second time (with CORS) to look at its pixels.
   */
  remoteContentAllowed?: boolean;
}

type ImageVerdict = 'plate' | 'fine' | 'unknown';

/**
 * Looks at an image's pixels: does it have see-through areas, and would what
 * it draws there disappear against `bg`? 'unknown' when the pixels can't be
 * read (a cross-origin image without CORS).
 */
function judgeImagePixels(source: HTMLImageElement, doc: Document, bg: Rgba): ImageVerdict {
  const w = source.naturalWidth, h = source.naturalHeight;
  if (!w || !h) return 'fine';
  const scale = Math.min(1, 48 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = doc.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 'unknown';
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(source, 0, 0, cw, ch);
    data = ctx.getImageData(0, 0, cw, ch).data;
  } catch {
    return 'unknown';
  }
  let clear = 0, drawn = 0, hidden = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.5) { clear++; continue; }
    drawn++;
    const px = composite({ r: data[i], g: data[i + 1], b: data[i + 2], a }, bg);
    if (contrastRatio(px, bg) < 2) hidden++;
  }
  const total = data.length / 4;
  // Opaque images cover any plate; mostly-readable artwork doesn't need one.
  if (clear / total < 0.02 || drawn === 0) return 'fine';
  return hidden / drawn > 0.35 ? 'plate' : 'fine';
}

function whenLoaded(img: HTMLImageElement): Promise<boolean> {
  if (img.complete) return Promise.resolve(img.naturalWidth > 0);
  return new Promise((resolve) => {
    img.addEventListener('load', () => resolve(true), { once: true });
    img.addEventListener('error', () => resolve(false), { once: true });
  });
}

/** Loads a second copy of a remote image with CORS so its pixels can be read. */
function loadCorsCopy(img: HTMLImageElement, doc: Document): Promise<HTMLImageElement | null> {
  const src = img.currentSrc || img.src;
  if (!/^https?:/i.test(src)) return Promise.resolve(null);
  const copy = doc.createElement('img');
  copy.crossOrigin = 'anonymous';
  copy.referrerPolicy = 'no-referrer';
  const loaded = new Promise<HTMLImageElement | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    copy.onload = () => { clearTimeout(timer); resolve(copy); };
    copy.onerror = () => { clearTimeout(timer); resolve(null); };
  });
  copy.src = src;
  return loaded;
}

async function plateIfNeeded(img: HTMLImageElement, surface: Surface, options: EmailDarkModeOptions): Promise<void> {
  if (!(await whenLoaded(img))) return;
  const doc = img.ownerDocument;
  // Spacers and tracking pixels.
  if (img.naturalWidth <= 2 && img.naturalHeight <= 2) return;
  let verdict = judgeImagePixels(img, doc, surface.bg);
  if (verdict === 'unknown' && options.remoteContentAllowed) {
    const copy = await loadCorsCopy(img, doc);
    if (copy) verdict = judgeImagePixels(copy, doc, surface.bg);
  }
  // Pixels we can't read get the plate: a light box around a logo is better
  // than a logo that isn't there.
  if (verdict === 'fine' || !img.isConnected) return;
  img.style.setProperty('background-color', formatColor(surface.original), 'important');
}

/**
 * Converts a rendered email document to dark colours in place. Call once,
 * after the document has parsed (styles applied); it is a no-op on a second
 * call because inline overrides then report the converted colours. Image
 * plates are decided once each image has loaded, after this returns.
 */
export function applyEmailDarkMode(doc: Document, options: EmailDarkModeOptions = {}): void {
  const win = doc.defaultView;
  const body = doc.body;
  try {
    if (!win || !body) return;
    // Un-pin the canvas to read the mail's own; nothing paints before the
    // writes below, so the light original never shows.
    const html = doc.documentElement;
    html.classList.remove(DARK_PENDING_CLASS);
    const ours = parseComputedColor('rgb(20, 20, 20)')!;
    const canvas = parseComputedColor(win.getComputedStyle(html).backgroundColor);
    // A mail that paints <html> itself gets that canvas darkened like any
    // other fill; left alone it shows wherever the body doesn't cover it.
    const mailCanvas = canvas && canvas.a === 1 && !sameColor(canvas, ours) ? canvas : null;
    const base: Rgba = mailCanvas ? darkenBackground(mailCanvas) : ours;

    // Read everything first, then write: interleaving would force a style
    // recalc per element.
    const elements: HTMLElement[] = [body];
    body.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (!SKIP_TAGS.has(el.tagName) && !el.closest('svg')) elements.push(el);
    });
    const snaps: Snapshot[] = elements.map((el) => {
      const cs = win.getComputedStyle(el);
      return {
        el,
        color: parseComputedColor(cs.color),
        bg: parseComputedColor(cs.backgroundColor),
        bgImage: cs.backgroundImage,
        borders: BORDER_SIDES.map((side) =>
          cs.getPropertyValue(`border-${side}-style`) !== 'none' && parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0
            ? parseComputedColor(cs.getPropertyValue(`border-${side}-color`))
            : null),
      };
    });

    // The original canvas is the mail's own or white: that is what the light
    // view paints.
    const root: Surface = { bg: base, original: mailCanvas ?? WHITE, onImage: false };
    const surfaces = new Map<Element, Surface>();
    const surfaceOf = (el: Element | null): Surface => {
      for (let n = el; n; n = n.parentElement) {
        const s = surfaces.get(n);
        if (s) return s;
      }
      return root;
    };

    const writes: Array<() => void> = [];
    if (mailCanvas && base !== mailCanvas) {
      writes.push(() => html.style.setProperty('background-color', formatColor(base), 'important'));
    }
    for (const snap of snaps) {
      const { el } = snap;
      const parent = el === body ? root : surfaceOf(el.parentElement);
      let surface = parent;
      const framed = snap.borders.some((border) => border !== null && border.a > 0);
      // The element's own dark fill was kept as sent (see keepSeparation).
      let keptDarkFill = false;

      if (hasImage(snap.bgImage)) {
        // Picture background: keep the element's own fill (it shows wherever
        // the picture is transparent or fails to load) and its text as sent.
        const fill = snap.bg && snap.bg.a > 0 ? composite(snap.bg, parent.bg) : parent.bg;
        surface = { bg: fill, original: fill, onImage: true };
      } else {
        if (snap.bgImage && snap.bgImage !== 'none' && !parent.onImage) {
          const gradient = mapGradientColors(snap.bgImage, darkenBackground);
          if (gradient !== snap.bgImage) writes.push(() => el.style.setProperty('background-image', gradient, 'important'));
        }
        // A translucent box over a picture still shows the picture, so it
        // keeps its colours; an opaque one is a surface of its own.
        if (el === body && snap.bg && sameColor(snap.bg, ours)) {
          // Our own dark canvas (emailDarkModeCss), not a fill the sender
          // chose: in the light view this is the white page.
        } else if (snap.bg && snap.bg.a > 0 && !(parent.onImage && snap.bg.a < 0.9)) {
          const original = snap.bg;
          // The body has no surroundings to stand out from.
          const next = parent.onImage || el === body
            ? darkenBackground(original)
            : keepSeparation(darkenBackground(original), original, parent, framed);
          keptDarkFill = next === original && original.a >= 0.9 && toLch(original).l <= BG_DARK_L;
          surface = {
            bg: composite(next, parent.bg),
            original: composite(original, parent.original),
            onImage: false,
          };
          if (next !== original) writes.push(() => el.style.setProperty('background-color', formatColor(next), 'important'));
        }
      }
      surfaces.set(el, surface);

      if (surface.onImage) continue;

      if (snap.color) {
        const next = ensureContrast(snap.color, surface.bg, 4.5);
        if (next !== snap.color) writes.push(() => el.style.setProperty('color', formatColor(next), 'important'));
      }
      snap.borders.forEach((border, i) => {
        if (!border || border.a === 0) return;
        // A border inside a block the pass left as sent (a dark card, a
        // signature, a brand banner) was drawn against that block's own fill.
        if (sameColor(parent.bg, parent.original)) return;
        // Borders sit between the element and its parent; a light rule on a
        // light mail darkens with the backgrounds, a dark one is lifted just
        // enough to stay visible - the frame of a kept dark fill in its own
        // hue, so it stays the subtle edge the sender drew.
        const darkened = darkenBackground(border);
        const next = darkened !== border
          ? darkened
          : keptDarkFill ? liftToContrast(border, parent.bg, 1.6) : ensureContrast(border, parent.bg, 1.6);
        if (next !== border) {
          writes.push(() => el.style.setProperty(`border-${BORDER_SIDES[i]}-color`, formatColor(next), 'important'));
        }
      });
    }

    // Images keep their pixels, but a transparent one (a black logo, a dark
    // icon) was drawn for the light background it sat on and can vanish on
    // the darkened one. Those get that original background back behind them.
    const plates: Array<{ img: HTMLImageElement; surface: Surface }> = [];
    body.querySelectorAll('img').forEach((img) => {
      const surface = surfaceOf(img.parentElement);
      if (surface.onImage || surface.bg === surface.original) return;
      if (toLch(surface.original).l < 0.7 || contrastRatio(surface.original, surface.bg) < 3) return;
      plates.push({ img, surface });
    });

    for (const write of writes) write();
    for (const { img, surface } of plates) void plateIfNeeded(img, surface, options);
  } finally {
    doc.documentElement.classList.remove(DARK_PENDING_CLASS);
  }
}
