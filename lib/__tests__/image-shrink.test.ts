import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shrinkImage, toBase64, MAX_SHRUNK_IMAGE_BYTES } from '../image-shrink';

// jsdom has no image decoder and no canvas: the browser's createImageBitmap
// and OffscreenCanvas are stood in for. A "picture" here is a blob holding
// JSON: its size and whether it has see-through pixels. Encoded sizes follow
// a formula the test sets, so the byte cap can be hit on purpose.

interface Fake { w: number; h: number; alpha?: boolean }
let bytesPer: (type: string, quality: number | undefined, w: number, h: number) => number;
const encoded: { type: string; quality?: number; w: number; h: number }[] = [];
const fills: string[] = [];

class FakeBitmap {
  constructor(readonly width: number, readonly height: number, readonly alpha: boolean) {}
  close() {}
}

class FakeCanvas {
  private drawn: FakeBitmap | null = null;
  constructor(public width: number, public height: number) {}
  getContext() {
    const draw = (bitmap: FakeBitmap) => { this.drawn = bitmap; };
    const drawn = () => this.drawn;
    return {
      globalCompositeOperation: 'source-over',
      fillStyle: '',
      drawImage(bitmap: FakeBitmap) { draw(bitmap); },
      fillRect() { fills.push(this.fillStyle); },
      getImageData(_x: number, _y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4).fill(255);
        if (drawn()?.alpha) data[3] = 0;
        return { data };
      },
    };
  }
  async convertToBlob({ type, quality }: { type: string; quality?: number }) {
    encoded.push({ type, quality, w: this.width, h: this.height });
    return new Blob([new Uint8Array(bytesPer(type, quality, this.width, this.height))], { type });
  }
}

const picture = (fake: Fake, type = 'image/jpeg') => new Blob([JSON.stringify(fake)], { type });

beforeEach(() => {
  encoded.length = 0;
  fills.length = 0;
  bytesPer = () => 1000;
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob, options: unknown) => {
    expect(options).toEqual({ imageOrientation: 'from-image' });
    const text = await blob.text();
    if (text === 'broken') throw new DOMException('cannot decode', 'InvalidStateError');
    const fake = JSON.parse(text) as Fake;
    return new FakeBitmap(fake.w, fake.h, !!fake.alpha);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('shrinkImage', () => {
  it('shrinks the long edge to 1568 px as a JPEG at 0.85 on white', async () => {
    const out = await shrinkImage(picture({ w: 4000, h: 3000 }));
    expect(out).toMatchObject({ status: 'ok', type: 'image/jpeg', width: 1568, height: 1176 });
    expect(out.bytes?.length).toBe(1000);
    expect(encoded).toEqual([{ type: 'image/jpeg', quality: 0.85, w: 1568, h: 1176 }]);
    expect(fills).toEqual(['#ffffff']);
  });

  it('takes a smaller long edge, and never makes an image larger', async () => {
    expect(await shrinkImage(picture({ w: 3000, h: 4000 }), { maxSide: 1024 })).toMatchObject({ width: 768, height: 1024 });
    expect(await shrinkImage(picture({ w: 800, h: 600 }))).toMatchObject({ status: 'ok', width: 800, height: 600 });
  });

  it('skips tracking pixels and tiny images without drawing them', async () => {
    expect(await shrinkImage(picture({ w: 1, h: 1 }, 'image/gif'))).toEqual({ status: 'tracker', width: 1, height: 1 });
    expect(await shrinkImage(picture({ w: 2, h: 2 }))).toMatchObject({ status: 'tracker' });
    expect(await shrinkImage(picture({ w: 40, h: 600 }))).toMatchObject({ status: 'tiny' });
    expect(await shrinkImage(picture({ w: 100, h: 100 }))).toMatchObject({ status: 'tiny' });
    expect(encoded).toEqual([]);
    expect(await shrinkImage(picture({ w: 130, h: 130 }))).toMatchObject({ status: 'ok' });
    // Asked for on purpose: small ones too, but never a tracker.
    expect(await shrinkImage(picture({ w: 40, h: 40 }), { small: true })).toMatchObject({ status: 'ok', width: 40 });
    expect(await shrinkImage(picture({ w: 1, h: 2 }), { small: true })).toMatchObject({ status: 'tracker' });
  });

  it('keeps a PNG with see-through parts as PNG, and turns an opaque one into JPEG', async () => {
    expect(await shrinkImage(picture({ w: 600, h: 400, alpha: true }, 'image/png'))).toMatchObject({ status: 'ok', type: 'image/png' });
    expect(fills).toEqual([]);
    expect(await shrinkImage(picture({ w: 600, h: 400 }, 'image/png'))).toMatchObject({ status: 'ok', type: 'image/jpeg' });
  });

  it('stays under 1.5 MB: quality 0.7 first, then a quarter smaller per step', async () => {
    bytesPer = (_t, q) => (q === 0.85 ? MAX_SHRUNK_IMAGE_BYTES + 1 : 1000);
    expect(await shrinkImage(picture({ w: 2000, h: 1000 }))).toMatchObject({ status: 'ok', width: 1568, height: 784 });
    expect(encoded.map((e) => e.quality)).toEqual([0.85, 0.7]);

    encoded.length = 0;
    bytesPer = (_t, _q, w) => (w > 1200 ? MAX_SHRUNK_IMAGE_BYTES + 1 : 1000);
    expect(await shrinkImage(picture({ w: 2000, h: 1000 }))).toMatchObject({ status: 'ok', width: 1176, height: 588 });

    bytesPer = () => MAX_SHRUNK_IMAGE_BYTES + 1;
    expect(await shrinkImage(picture({ w: 2000, h: 1000 }))).toEqual({ status: 'too_big', width: 2000, height: 1000 });
  });

  it('answers unsupported for what the browser can not decode', async () => {
    expect(await shrinkImage(new Blob(['broken'], { type: 'image/heic' }))).toEqual({ status: 'unsupported' });
  });
});

describe('toBase64', () => {
  it('encodes large byte arrays', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(atob(toBase64(bytes)).length).toBe(100_000);
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});
