/**
 * Pause animated images in a message (Settings > Accessibility > "Pause
 * animated images"): each animated GIF, WebP or APNG shows a still frame
 * with a Play button, and Pause once it plays.
 *
 * The message frame is sandboxed without scripts, so all of this runs from
 * the parent document: the still frame is drawn onto a canvas and shown as a
 * picture of its own in the image's place. The canvas itself can't be shown:
 * a frame that may not run scripts renders a canvas as its (empty) fallback
 * content. The toggle works without any script: a checkbox holds the
 * state and an injected stylesheet shows the still or the moving image.
 * WebKit does not run parent-attached listeners on nodes of a frame that is
 * sandboxed without allow-scripts, so a click handler never fired in Safari
 * (the same cause as the quote toggle, see lib/quote-collapse.ts).
 */

import { REMOTE_CONTENT_PATH, decodeRemoteUrl } from '@/lib/remote-content-proxy';

/** Whether image bytes hold more than one frame. */
export function isAnimatedImageData(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

  // GIF: count the image descriptors, skipping extension and data blocks.
  if (ascii(0, 4) === 'GIF8') {
    let i = 13;
    const flags = bytes[10];
    if (flags & 0x80) i += 3 * (1 << ((flags & 0x07) + 1));
    let frames = 0;
    const skipSubBlocks = () => {
      while (i < bytes.length && bytes[i] !== 0) i += bytes[i] + 1;
      i += 1;
    };
    while (i < bytes.length) {
      const block = bytes[i];
      if (block === 0x2c) {
        frames += 1;
        if (frames > 1) return true;
        const local = bytes[i + 9];
        i += 10;
        if (local & 0x80) i += 3 * (1 << ((local & 0x07) + 1));
        i += 1; // LZW minimum code size
        skipSubBlocks();
      } else if (block === 0x21) {
        i += 2;
        skipSubBlocks();
      } else {
        break; // 0x3b trailer, or garbage
      }
    }
    return false;
  }

  // PNG: an acTL chunk before the image data makes it an APNG.
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    let i = 8;
    while (i + 8 <= bytes.length) {
      const length = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      const type = ascii(i + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      i += 12 + length;
    }
    return false;
  }

  // WebP: the extended header's animation flag, or an ANIM chunk.
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    if (ascii(12, 4) === 'VP8X' && bytes.length > 20) return (bytes[20] & 0x02) !== 0;
    return false;
  }
  return false;
}

/**
 * For an image whose bytes we can't read (a remote URL: the app's own CSP
 * doesn't let it fetch other hosts), whether its name says it may move.
 * Animated WebP is rare enough that a .webp is left playing.
 */
export function remoteImageMayBeAnimated(src: string): boolean {
  try {
    const { pathname } = new URL(src);
    // Through this server's proxy the path ends in a token: its name is the
    // address it carries (#1872).
    const at = pathname.lastIndexOf(REMOTE_CONTENT_PATH);
    if (at >= 0) {
      const carried = decodeRemoteUrl(pathname.slice(at + REMOTE_CONTENT_PATH.length));
      return carried ? /\.(gif|apng)$/i.test(new URL(carried).pathname) : false;
    }
    return /\.(gif|apng)$/i.test(pathname);
  } catch {
    return false;
  }
}

async function readBytes(src: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** Whether to pause this (loaded) image. */
export async function imageIsAnimated(src: string, read: (src: string) => Promise<Uint8Array | null> = readBytes): Promise<boolean> {
  if (!src) return false;
  if (/^(data|blob):/i.test(src)) {
    const bytes = await read(src);
    return bytes ? isAnimatedImageData(bytes) : false;
  }
  return /^https?:/i.test(src) && remoteImageMayBeAnimated(src);
}

export interface PauseLabels {
  play: string;
  pause: string;
}

const WRAP_ATTR = 'data-bulwark-animation-wrap';
/** Marks the toggle's label. */
const TOGGLE_ATTR = 'data-bulwark-animation';
/** Marks the label's two texts; the value is the action it names. */
const LABEL_ATTR = 'data-bulwark-animation-label';
/** Marks an image this pass has looked at (the moving one, once paused). */
const SEEN_ATTR = 'data-bulwark-animated';
/** Marks what stands in for a paused image: its still frame, or a placeholder. */
const STILL_ATTR = 'data-bulwark-still';
const STYLE_ATTR = 'data-bulwark-animation-style';

/**
 * The checkbox sits right before its label, the still and the image, so
 * sibling selectors switch them and no :has() is needed. Checked means
 * playing. !important beats the mail's own inline display on the image, and
 * the one the still copied from it.
 */
const STYLE = `[${WRAP_ATTR}]{position:relative;display:inline-block;max-width:100%;line-height:0}
[${WRAP_ATTR}]>input{position:absolute;top:0;left:0;width:1px;height:1px;margin:0;padding:0;opacity:0;pointer-events:none}
[${STILL_ATTR}]{max-width:100%;height:auto}
span[${STILL_ATTR}]{display:inline-block;box-sizing:border-box;border:1px solid #9ca3af;background:#e5e7eb}
[${WRAP_ATTR}]>input:checked~[${STILL_ATTR}],[${WRAP_ATTR}]>input:not(:checked)~img[${SEEN_ATTR}]{display:none!important}
[${WRAP_ATTR}]>input:checked+label>[${LABEL_ATTR}="play"],[${WRAP_ATTR}]>input:not(:checked)+label>[${LABEL_ATTR}="pause"]{display:none!important}
label[${TOGGLE_ATTR}]{position:absolute;top:6px;inset-inline-start:6px;z-index:1;box-sizing:border-box;min-width:32px;min-height:32px;padding:4px 10px;border:2px solid #fff;border-radius:999px;background:rgba(0,0,0,.75);color:#fff;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer;user-select:none;animation:none!important;transition:none!important}
[${WRAP_ATTR}]>input:focus-visible+label{outline:3px solid #1d4ed8;outline-offset:2px}`;

let toggleIds = 0;

/**
 * Freezes the animated images of a rendered message. Each one is swapped for
 * a picture of its first frame, with a Play button on top; Play shows the
 * moving image again and the button becomes Pause, which shows the first
 * frame again. A canvas only ever gets the first frame of an animated image
 * (the HTML spec's "default image"), so the frame it stopped at can't be
 * kept.
 *
 * The frame can only be read back from an image of this origin (a data: or
 * blob: part, or one through the remote content proxy). An image straight
 * from another server would taint the canvas, so it is paused behind a
 * neutral placeholder of its size instead. Returns a cleanup that drops the
 * listeners.
 */
export function pauseAnimatedImages(
  doc: Document,
  labels: PauseLabels,
  options: { isAnimated?: (src: string) => Promise<boolean> } = {},
): () => void {
  const isAnimated = options.isAnimated ?? ((src: string) => imageIsAnimated(src));
  let disposed = false;

  if (!doc.head.querySelector(`style[${STYLE_ATTR}]`)) {
    const style = doc.createElement('style');
    style.setAttribute(STYLE_ATTR, '');
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }

  /** The image's first frame as a data: URL; null when it can't be read. */
  const snapshot = (img: HTMLImageElement): string | null => {
    const canvas = doc.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    try {
      context.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return null; // tainted: from another origin
    }
  };

  const freeze = (img: HTMLImageElement) => {
    if (disposed || img.hasAttribute(SEEN_ATTR) || img.hasAttribute(STILL_ATTR) || img.naturalWidth <= 1) return;
    img.setAttribute(SEEN_ATTR, '');
    void isAnimated(img.currentSrc || img.getAttribute('src') || '').then((animated) => {
      if (!animated || disposed || !img.isConnected) return;
      const frame = snapshot(img);
      const alt = img.getAttribute('alt')?.trim() ?? '';
      let still: HTMLElement;
      if (frame) {
        const picture = doc.createElement('img');
        picture.src = frame;
        picture.alt = alt;
        still = picture;
      } else {
        still = doc.createElement('span');
        if (alt) {
          still.setAttribute('role', 'img');
          still.setAttribute('aria-label', alt);
        } else {
          still.setAttribute('aria-hidden', 'true');
        }
      }
      still.setAttribute(STILL_ATTR, '');
      for (const attr of ['class', 'style']) {
        const value = img.getAttribute(attr);
        if (value) still.setAttribute(attr, value);
      }
      // An inline `display: … !important` beats the stylesheet's !important,
      // so the paused image (and the still, which copied its style) would
      // stay visible. Keep the mail's value, drop the priority.
      for (const el of [img, still]) {
        if (el.style.getPropertyPriority('display') === 'important') {
          el.style.setProperty('display', el.style.getPropertyValue('display'));
        }
      }
      // The layout width: the reader may scale the whole body to fit the
      // pane (email-fit-width.ts), and a measured box already holds that
      // scale, which the still would then get a second time.
      const width = img.offsetWidth || img.width || img.naturalWidth;
      still.style.width = `${width}px`;
      // Keeps the image's shape, also where max-width narrows it.
      if (!frame) still.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;

      const wrap = doc.createElement('span');
      wrap.setAttribute(WRAP_ATTR, '');
      // Visually hidden but still focusable, so the button works from the
      // keyboard. The id ties the label to it: the label can't wrap it, the
      // still and the image have to follow it as siblings.
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      do checkbox.id = `bulwark-animation-${++toggleIds}`;
      while (doc.getElementById(checkbox.id)); // the mail may use the name
      // Both texts are in the markup and the stylesheet shows the one that
      // matches the state, so the checkbox's accessible name follows it too.
      const label = doc.createElement('label');
      label.setAttribute(TOGGLE_ATTR, '');
      label.htmlFor = checkbox.id;
      for (const action of ['play', 'pause'] as const) {
        const text = doc.createElement('span');
        text.setAttribute(LABEL_ATTR, action);
        text.textContent = labels[action];
        label.appendChild(text);
      }

      img.parentNode?.insertBefore(wrap, img);
      wrap.append(checkbox, label, still, img);
    });
  };

  // Only where the frame runs our listeners (not in Safari), in the capture
  // phase and ahead of the reader's link handling: a click on the toggle
  // inside a linked image must not reach the link handler, which would open
  // the link. No preventDefault, the click is what flips the checkbox. Where
  // these don't run, the link isn't opened either: a click on a label or a
  // checkbox never activates the link around it.
  const toggleOf = (target: EventTarget | null) =>
    (target as Element | null)?.closest?.(`[${WRAP_ATTR}]>label[${TOGGLE_ATTR}],[${WRAP_ATTR}]>input`) ?? null;
  const onClick = (event: Event) => {
    if (toggleOf(event.target)) event.stopImmediatePropagation();
  };
  // The old button toggled on Enter as well as Space; a checkbox answers
  // only Space. Where these listeners run, Enter flips it too. In Safari
  // Space is left, which works there natively.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const checkbox = event.target as HTMLInputElement | null;
    if (!checkbox?.matches?.(`[${WRAP_ATTR}]>input`)) return;
    event.preventDefault();
    checkbox.click();
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown, true);

  doc.querySelectorAll('img').forEach((img) => {
    if (img.complete) freeze(img);
    // WebKit doesn't call a load listener here either, but decode() settles
    // once the image has loaded.
    else if (typeof img.decode === 'function') img.decode().then(() => freeze(img), () => {});
    else img.addEventListener('load', () => freeze(img), { once: true });
  });

  return () => {
    disposed = true;
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}
