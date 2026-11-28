/**
 * Pause animated images in a message (Settings > Accessibility > "Pause
 * animated images"): each animated GIF, WebP or APNG shows a still frame
 * with a Play button, and Pause once it plays.
 *
 * The message frame is sandboxed without scripts, so all of this runs from
 * the parent document: the still frame is drawn onto a canvas that takes the
 * image's place, and the button's listener lives in our own window.
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

const TOGGLE_ATTR = 'data-bulwark-animation';
const STILL_ATTR = 'data-bulwark-still';

const STYLE = `[${TOGGLE_ATTR}-wrap]{position:relative;display:inline-block;max-width:100%;line-height:0}
canvas[${STILL_ATTR}]{max-width:100%;height:auto}
button[${TOGGLE_ATTR}]{position:absolute;top:6px;inset-inline-start:6px;z-index:1;min-width:32px;min-height:32px;padding:4px 10px;border:2px solid #fff;border-radius:999px;background:rgba(0,0,0,.75);color:#fff;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer;animation:none!important;transition:none!important}
button[${TOGGLE_ATTR}]:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}`;

/**
 * Freezes the animated images of a rendered message. Each one is swapped for
 * a canvas holding its current (first) frame, with a Play button on top;
 * Play shows the moving image again and the button becomes Pause, which draws
 * the frame it stopped at. Returns a cleanup that drops the listener.
 */
export function pauseAnimatedImages(
  doc: Document,
  labels: PauseLabels,
  options: { isAnimated?: (src: string) => Promise<boolean> } = {},
): () => void {
  const isAnimated = options.isAnimated ?? ((src: string) => imageIsAnimated(src));
  let disposed = false;

  if (!doc.head.querySelector(`style[${TOGGLE_ATTR}]`)) {
    const style = doc.createElement('style');
    style.setAttribute(TOGGLE_ATTR, '');
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }

  const draw = (img: HTMLImageElement, canvas: HTMLCanvasElement): boolean => {
    const context = canvas.getContext('2d');
    if (!context) return false;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    try {
      context.drawImage(img, 0, 0);
    } catch {
      return false;
    }
    return true;
  };

  const freeze = (img: HTMLImageElement) => {
    if (disposed || img.hasAttribute(STILL_ATTR) || img.naturalWidth <= 1) return;
    img.setAttribute(STILL_ATTR, '');
    void isAnimated(img.currentSrc || img.getAttribute('src') || '').then((animated) => {
      if (!animated || disposed || !img.isConnected) return;
      const canvas = doc.createElement('canvas');
      if (!draw(img, canvas)) return;
      const width = img.getBoundingClientRect().width;
      canvas.setAttribute(STILL_ATTR, '');
      for (const attr of ['class', 'style']) {
        const value = img.getAttribute(attr);
        if (value) canvas.setAttribute(attr, value);
      }
      if (width > 0) canvas.style.width = `${width}px`;
      const alt = img.getAttribute('alt')?.trim();
      if (alt) {
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', alt);
      } else {
        canvas.setAttribute('aria-hidden', 'true');
      }

      const wrap = doc.createElement('span');
      wrap.setAttribute(`${TOGGLE_ATTR}-wrap`, '');
      const button = doc.createElement('button');
      button.type = 'button';
      button.setAttribute(TOGGLE_ATTR, 'paused');
      button.textContent = labels.play;

      img.parentNode?.insertBefore(wrap, img);
      wrap.append(button, canvas, img);
      img.style.setProperty('display', 'none', 'important');
    });
  };

  // One listener on the document, in the capture phase and ahead of the
  // reader's link handling: a button inside a linked image must not also
  // open the link.
  const onClick = (event: Event) => {
    const button = (event.target as Element | null)?.closest?.(`button[${TOGGLE_ATTR}]`) as HTMLButtonElement | null;
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const wrap = button.parentElement;
    const canvas = wrap?.querySelector<HTMLCanvasElement>(`canvas[${STILL_ATTR}]`);
    const img = wrap?.querySelector('img');
    if (!canvas || !img) return;
    if (button.getAttribute(TOGGLE_ATTR) === 'paused') {
      img.style.removeProperty('display');
      canvas.style.setProperty('display', 'none');
      button.setAttribute(TOGGLE_ATTR, 'playing');
      button.textContent = labels.pause;
    } else {
      draw(img, canvas);
      canvas.style.removeProperty('display');
      img.style.setProperty('display', 'none', 'important');
      button.setAttribute(TOGGLE_ATTR, 'paused');
      button.textContent = labels.play;
    }
  };
  doc.addEventListener('click', onClick, true);

  doc.querySelectorAll('img').forEach((img) => {
    if (img.complete) freeze(img);
    else img.addEventListener('load', () => freeze(img), { once: true });
  });

  return () => {
    disposed = true;
    doc.removeEventListener('click', onClick, true);
  };
}
