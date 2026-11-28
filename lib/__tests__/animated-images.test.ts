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
  beforeEach(() => drawImage.mockReset());
  afterEach(() => vi.restoreAllMocks());

  function frameDoc(html: string): Document {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    // jsdom has no canvas; the frame's own realm needs the stub.
    const win = doc.defaultView as unknown as typeof window;
    vi.spyOn(win.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
    doc.body.innerHTML = html;
    doc.querySelectorAll('img').forEach((img) => {
      Object.defineProperty(img, 'complete', { value: true });
      Object.defineProperty(img, 'naturalWidth', { value: 40 });
      Object.defineProperty(img, 'naturalHeight', { value: 20 });
    });
    return doc;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('shows a still frame with a Play button, then Pause while it plays', async () => {
    const doc = frameDoc('<a href="https://ex.com"><img src="https://cdn.example/a.gif" alt="Dancing cat"></a>');
    const linkClicks = vi.fn();
    pauseAnimatedImages(doc, { play: 'Play animation', pause: 'Pause animation' });
    // The reader's link handler, registered after.
    doc.addEventListener('click', linkClicks, true);
    await flush();

    const img = doc.querySelector('img')!;
    const canvas = doc.querySelector('canvas')!;
    const button = doc.querySelector('button')!;
    expect(img.style.display).toBe('none');
    expect(canvas.getAttribute('aria-label')).toBe('Dancing cat');
    expect(drawImage).toHaveBeenCalledWith(img, 0, 0);
    expect(button.textContent).toBe('Play animation');

    button.click();
    expect(img.style.display).toBe('');
    expect(canvas.style.display).toBe('none');
    expect(button.textContent).toBe('Pause animation');
    expect(linkClicks).not.toHaveBeenCalled();

    button.click();
    expect(img.style.display).toBe('none');
    expect(button.textContent).toBe('Play animation');
  });

  it('leaves still images alone', async () => {
    const doc = frameDoc('<img src="https://cdn.example/photo.jpg" alt="Photo">');
    pauseAnimatedImages(doc, { play: 'Play', pause: 'Pause' });
    await flush();
    expect(doc.querySelector('canvas')).toBeNull();
    expect(doc.querySelector('button')).toBeNull();
  });
});
