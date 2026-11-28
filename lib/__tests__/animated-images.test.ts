import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageIsAnimated, isAnimatedImageData, pauseAnimatedImages, remoteImageMayBeAnimated } from '@/lib/animated-images';
import { proxiedResourceUrl } from '@/lib/remote-content-proxy';

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

/** A minimal GIF with `frames` 1x1 frames and no colour tables. */
function gif(frames: number): Uint8Array {
  const frame = [
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // graphic control extension
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, // image descriptor, no local table
    0x02, 0x02, 0x44, 0x01, 0x00, // LZW data
  ];
  return bytes('GIF89a', [1, 0, 1, 0, 0x00, 0, 0], ...Array.from({ length: frames }, () => frame), [0x3b]);
}

describe('isAnimatedImageData', () => {
  it('tells an animated GIF from a still one', () => {
    expect(isAnimatedImageData(gif(1))).toBe(false);
    expect(isAnimatedImageData(gif(3))).toBe(true);
  });

  it('finds the APNG animation chunk before the image data', () => {
    const chunk = (type: string, length = 0) => [0, 0, 0, length, ...[...type].map((c) => c.charCodeAt(0)), ...new Array(length).fill(0), 0, 0, 0, 0];
    const png = (...chunks: number[][]) => bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], ...chunks);
    expect(isAnimatedImageData(png(chunk('IHDR', 13), chunk('acTL', 8), chunk('IDAT', 2)))).toBe(true);
    expect(isAnimatedImageData(png(chunk('IHDR', 13), chunk('IDAT', 2), chunk('IEND')))).toBe(false);
  });

  it('reads the WebP animation flag', () => {
    const webp = (flags: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0, flags, 0, 0, 0]);
    expect(isAnimatedImageData(webp(0x02))).toBe(true);
    expect(isAnimatedImageData(webp(0x10))).toBe(false);
  });

  it('is false for anything else', () => {
    expect(isAnimatedImageData(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF______'))).toBe(false);
  });
});

describe('imageIsAnimated', () => {
  it('reads the bytes of inline images', async () => {
    expect(await imageIsAnimated('blob:x', async () => gif(2))).toBe(true);
    expect(await imageIsAnimated('data:image/gif;base64,AA', async () => gif(1))).toBe(false);
  });
  it('goes by the name for remote images', async () => {
    expect(remoteImageMayBeAnimated('https://cdn.example/promo.GIF?x=1')).toBe(true);
    expect(await imageIsAnimated('https://cdn.example/photo.jpg', async () => gif(2))).toBe(false);
  });
  // #1872: through this server's proxy the path ends in a token.
  it('goes by the carried name for proxied remote images', () => {
    const base = 'https://mail.example.org/webmail/api/remote-content/';
    expect(remoteImageMayBeAnimated(proxiedResourceUrl('https://cdn.example/promo.gif?x=1', base)!)).toBe(true);
    expect(remoteImageMayBeAnimated(proxiedResourceUrl('https://cdn.example/photo.jpg', base)!)).toBe(false);
    expect(remoteImageMayBeAnimated(`${base}not-a-token`)).toBe(false);
  });
});

describe('pauseAnimatedImages', () => {
  const drawImage = vi.fn();
  const FRAME = 'data:image/png;base64,c3RpbGw=';
  beforeEach(() => drawImage.mockReset());
  afterEach(() => vi.restoreAllMocks());

  function frameDoc(html: string, { complete = true, tainted = false } = {}): Document {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    // jsdom has no canvas; the frame's own realm needs the stub.
    const win = doc.defaultView as unknown as typeof window;
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
    vi.spyOn(win.HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      // What a browser does for an image from another server.
      if (tainted) throw new win.DOMException('The operation is insecure.', 'SecurityError');
      return FRAME;
    });
    doc.body.innerHTML = html;
    doc.querySelectorAll('img').forEach((img) => {
      Object.defineProperty(img, 'complete', { value: complete });
      Object.defineProperty(img, 'naturalWidth', { value: 40 });
      Object.defineProperty(img, 'naturalHeight', { value: 20 });
    });
    return doc;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const display = (doc: Document, el: Element) => doc.defaultView!.getComputedStyle(el).display;
  const shownLabel = (doc: Document, wrap: Element) =>
    Array.from(wrap.querySelectorAll('[data-bulwark-animation-label]'))
      .filter((el) => display(doc, el) !== 'none')
      .map((el) => el.textContent)
      .join('|');

  it('shows the first frame as a picture with a Play toggle, then Pause while it plays', async () => {
    const doc = frameDoc('<a href="https://ex.com"><img src="https://cdn.example/a.gif" class="hero" alt="Dancing cat"></a>');
    const linkClicks = vi.fn();
    pauseAnimatedImages(doc, { play: 'Play animation', pause: 'Pause animation' });
    // The reader's link handler, registered after.
    doc.addEventListener('click', linkClicks, true);
    await flush();

    const wrap = doc.querySelector('[data-bulwark-animation-wrap]')!;
    const [still, img] = Array.from(wrap.querySelectorAll('img'));
    const label = doc.querySelector('label')!;
    const checkbox = doc.querySelector('input')!;
    expect(wrap.closest('a')).not.toBeNull();
    expect(img.getAttribute('src')).toBe('https://cdn.example/a.gif');
    expect(display(doc, img)).toBe('none');
    expect(drawImage).toHaveBeenCalledWith(img, 0, 0);
    // A canvas would show as its empty fallback in a frame without scripts.
    expect(doc.querySelector('canvas')).toBeNull();
    expect(still.hasAttribute('data-bulwark-still')).toBe(true);
    expect(still.getAttribute('src')).toBe(FRAME);
    expect(still.alt).toBe('Dancing cat');
    expect(still.className).toBe('hero');
    expect(display(doc, still)).not.toBe('none');
    expect(checkbox.checked).toBe(false);
    expect(shownLabel(doc, wrap)).toBe('Play animation');

    label.click();
    expect(checkbox.checked).toBe(true);
    expect(display(doc, img)).not.toBe('none');
    expect(display(doc, still)).toBe('none');
    expect(shownLabel(doc, wrap)).toBe('Pause animation');
    expect(linkClicks).not.toHaveBeenCalled();

    label.click();
    expect(checkbox.checked).toBe(false);
    expect(display(doc, img)).toBe('none');
    expect(display(doc, still)).not.toBe('none');
    expect(shownLabel(doc, wrap)).toBe('Play animation');
    expect(linkClicks).not.toHaveBeenCalled();
    // Drawn once: a canvas only ever gets the first frame of an animation.
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it('switches by stylesheet alone, for frames where no listener runs (Safari)', async () => {
    const doc = frameDoc('<img src="https://cdn.example/a.gif" style="display:block" alt="">');
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    await flush();
    const wrap = doc.querySelector('[data-bulwark-animation-wrap]')!;
    const still = doc.querySelector('[data-bulwark-still]')!;
    const img = doc.querySelector('img[data-bulwark-animated]')!;
    const checkbox = doc.querySelector('input')!;
    // The mail's own inline display stays on the image, untouched.
    expect(img.getAttribute('style')).toBe('display:block');
    expect(display(doc, img)).toBe('none');

    // WebKit runs no parent-attached listener in a frame sandboxed without
    // allow-scripts; only the checkbox's native state changes on a click.
    checkbox.checked = true;
    expect(display(doc, img)).toBe('block');
    expect(display(doc, still)).toBe('none');
    expect(shownLabel(doc, wrap)).toBe('Pause');
    checkbox.checked = false;
    expect(display(doc, img)).toBe('none');
    expect(display(doc, still)).not.toBe('none');
    expect(shownLabel(doc, wrap)).toBe('Play');
  });

  it('pauses an image from another server behind a placeholder of its size', async () => {
    const doc = frameDoc('<img src="https://cdn.example/a.gif" alt="Dancing cat">', { tainted: true });
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    await flush();
    const img = doc.querySelector('img[data-bulwark-animated]')!;
    const still = doc.querySelector<HTMLElement>('[data-bulwark-still]')!;
    expect(still.tagName).toBe('SPAN');
    expect(still.getAttribute('role')).toBe('img');
    expect(still.getAttribute('aria-label')).toBe('Dancing cat');
    expect(still.style.width).toBe('40px');
    expect(still.style.aspectRatio).toBe('40 / 20');
    expect(display(doc, img)).toBe('none');
    expect(display(doc, still)).not.toBe('none');
  });

  it('keeps a paused image hidden when its inline display is !important', async () => {
    const doc = frameDoc('<img src="https://cdn.example/a.gif" style="display:block !important" alt="">');
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    await flush();
    const img = doc.querySelector<HTMLImageElement>('img[data-bulwark-animated]')!;
    const still = doc.querySelector<HTMLElement>('[data-bulwark-still]')!;
    const checkbox = doc.querySelector('input')!;
    expect(img.style.getPropertyPriority('display')).toBe('');
    expect(img.style.getPropertyValue('display')).toBe('block');
    expect(still.style.getPropertyPriority('display')).toBe('');
    expect(display(doc, img)).toBe('none');
    expect(display(doc, still)).not.toBe('none');

    checkbox.checked = true;
    expect(display(doc, img)).toBe('block');
    expect(display(doc, still)).toBe('none');
  });

  it('toggles on Enter as well as Space, where listeners run', async () => {
    const doc = frameDoc('<a href="https://ex.com"><img src="https://cdn.example/a.gif" alt=""></a>');
    const linkClicks = vi.fn();
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    doc.addEventListener('click', linkClicks, true);
    await flush();
    const checkbox = doc.querySelector('input')!;
    const enter = () => {
      const event = new (doc.defaultView as unknown as typeof window).KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      checkbox.dispatchEvent(event);
      return event;
    };

    expect(enter().defaultPrevented).toBe(true);
    expect(checkbox.checked).toBe(true);
    enter();
    expect(checkbox.checked).toBe(false);
    expect(linkClicks).not.toHaveBeenCalled();
  });

  it('names each checkbox by its own label', async () => {
    const doc = frameDoc('<img src="https://cdn.example/a.gif" alt=""><img src="https://cdn.example/b.gif" alt="">');
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    await flush();
    const checkboxes = Array.from(doc.querySelectorAll('input'));
    const labels = Array.from(doc.querySelectorAll('label'));
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].id).not.toBe(checkboxes[1].id);
    checkboxes.forEach((checkbox, i) => {
      expect(checkbox.type).toBe('checkbox');
      expect(labels[i].htmlFor).toBe(checkbox.id);
      expect(checkbox.labels?.[0]).toBe(labels[i]);
    });
  });

  it('does not pause the still picture or the image again on a second pass', async () => {
    const doc = frameDoc('<img src="https://cdn.example/a.gif" alt="">');
    const isAnimated = vi.fn(async () => true);
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' }, { isAnimated });
    await flush();
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' }, { isAnimated });
    await flush();
    expect(isAnimated).toHaveBeenCalledTimes(1);
    expect(doc.querySelectorAll('[data-bulwark-animation-wrap]')).toHaveLength(1);
  });

  it('pauses an image that loads later without a load listener', async () => {
    const doc = frameDoc('<img src="https://cdn.example/a.gif" alt="">', { complete: false });
    const img = doc.querySelector('img')!;
    let loaded!: () => void;
    // WebKit never calls a load listener added from the parent; decode() still settles.
    const decode = vi.fn(() => new Promise<void>((resolve) => { loaded = resolve; }));
    Object.defineProperty(img, 'decode', { value: decode });
    const addEventListener = vi.spyOn(img, 'addEventListener');
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    await flush();
    expect(doc.querySelector('[data-bulwark-still]')).toBeNull();

    loaded();
    await flush();
    expect(decode).toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalledWith('load', expect.anything(), expect.anything());
    expect(doc.querySelector('[data-bulwark-still]')).not.toBeNull();
    expect(display(doc, img)).toBe('none');
  });

  it('leaves still images alone', async () => {
    const doc = frameDoc('<img src="https://cdn.example/photo.jpg" alt="Photo">');
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    await flush();
    expect(doc.querySelector('[data-bulwark-still]')).toBeNull();
    expect(doc.querySelector('label')).toBeNull();
  });
});
