// Shrinks an image for a reader that only needs to see it, such as an AI
// model: decoded with createImageBitmap (which turns photos upright from
// their EXIF orientation and takes the first frame of an animation), drawn
// smaller on a canvas, and saved as JPEG on white, or as PNG when the image
// has see-through parts. Images too small to show anything (tracking pixels,
// spacers, icons) are not drawn at all.

import { IMAGE_HEADER_BYTES, imageDimensions } from './image-size';

/** Default and allowed range of the long edge, in pixels. */
export const DEFAULT_IMAGE_SIDE = 1568;
export const MIN_IMAGE_SIDE = 64;
export const MAX_IMAGE_SIDE = 2576;
/** Largest image this returns, in bytes. */
export const MAX_SHRUNK_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** Both sides at most this: a tracking pixel. */
const TRACKER_SIDE = 2;
/** A side under this, or an area under TINY_AREA: too small to matter. */
const TINY_SIDE = 64;
const TINY_AREA = 128 * 128;

export type ShrinkStatus = 'ok' | 'tiny' | 'tracker' | 'too_big' | 'unsupported' | 'failed';

export interface ShrinkResult {
  status: ShrinkStatus;
  /** 'image/jpeg' or 'image/png' when ok. */
  type?: 'image/jpeg' | 'image/png';
  /** Size of the result when ok, else of the image as decoded (when it could be). */
  width?: number;
  height?: number;
  /** The encoded image when ok. */
  bytes?: Uint8Array;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encode(canvas: AnyCanvas, type: 'image/jpeg' | 'image/png', quality?: number): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, type, quality));
}

/** True when any pixel is not fully opaque. */
function hasTransparency(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

/** Long edge `maxSide` at most, aspect kept, never larger than the source. */
export function fitSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Types the browser may decode that can carry transparency. */
const ALPHA_TYPES = /^image\/(png|webp|gif|avif)$/i;

/** Most pixels an image may declare; a larger one is not decoded (its pixels alone could fill the memory). */
export const MAX_IMAGE_PIXELS = 50_000_000;

/**
 * Decodes with the photo's EXIF orientation and, when given, a smaller
 * width. Browsers before imageOrientation (or resize) throw a TypeError on
 * the options: then without them.
 */
async function decode(blob: Blob, resizeWidth: number | null): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, {
      imageOrientation: 'from-image',
      // Only the width: the browser keeps the aspect, whichever way EXIF turns the photo.
      ...(resizeWidth ? { resizeWidth, resizeQuality: 'high' as const } : {}),
    });
  } catch (err) {
    if (err instanceof TypeError) return createImageBitmap(blob);
    throw err;
  }
}

/**
 * The image in `blob`, at most `maxSide` on its long edge and
 * MAX_SHRUNK_IMAGE_BYTES in size. JPEG at quality 0.85, then 0.7, then
 * smaller by a quarter per step until it fits; PNG when transparent.
 * `small`: also shrink images below the "tiny" limits (still not trackers).
 * The size comes from the file's header before anything is decoded: a
 * format whose header isn't read here is unsupported, more than
 * MAX_IMAGE_PIXELS too_big, trackers and tiny images are never decoded.
 */
export async function shrinkImage(blob: Blob, { maxSide = DEFAULT_IMAGE_SIDE, small = false }: { maxSide?: number; small?: boolean } = {}): Promise<ShrinkResult> {
  if (typeof createImageBitmap !== 'function') return { status: 'unsupported' };
  const declared = imageDimensions(new Uint8Array(await blob.slice(0, IMAGE_HEADER_BYTES).arrayBuffer()));
  // HEIC, TIFF, SVG, a damaged file: no size to check, nothing to decode.
  if (!declared || declared.width < 1 || declared.height < 1) return { status: 'unsupported' };
  const { width: w, height: h } = declared;
  if (w * h > MAX_IMAGE_PIXELS) return { status: 'too_big', width: w, height: h };
  if (w <= TRACKER_SIDE && h <= TRACKER_SIDE) return { status: 'tracker', width: w, height: h };
  if (!small && (Math.min(w, h) < TINY_SIDE || w * h < TINY_AREA)) return { status: 'tiny', width: w, height: h };
  const side = Math.max(MIN_IMAGE_SIDE, Math.min(MAX_IMAGE_SIDE, Math.round(maxSide)));
  const target = fitSize(w, h, side);
  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(blob, target.width < w ? target.width : null);
  } catch {
    // A broken file: nothing the browser can show.
    return { status: 'unsupported', width: w, height: h };
  }
  try {
    let size = fitSize(bitmap.width, bitmap.height, side);
    let transparent: boolean | null = ALPHA_TYPES.test(blob.type) ? null : false;
    for (let step = 0; step < 12; step++) {
      const canvas = makeCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
      if (!ctx) return { status: 'failed' };
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      if (transparent === null) transparent = hasTransparency(ctx, size.width, size.height);
      const tries: [('image/jpeg' | 'image/png'), number | undefined][] = transparent ? [['image/png', undefined]] : [['image/jpeg', 0.85], ['image/jpeg', 0.7]];
      if (!transparent) {
        // JPEG has no transparency: what shows through becomes white, not black.
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size.width, size.height);
      }
      for (const [type, quality] of tries) {
        const out = await encode(canvas, type, quality);
        if (!out) return { status: 'failed' };
        if (out.size <= MAX_SHRUNK_IMAGE_BYTES) {
          return { status: 'ok', type, width: size.width, height: size.height, bytes: new Uint8Array(await out.arrayBuffer()) };
        }
      }
      const next = { width: Math.floor(size.width * 0.75), height: Math.floor(size.height * 0.75) };
      if (Math.max(next.width, next.height) < MIN_IMAGE_SIDE) break;
      size = next;
    }
    return { status: 'too_big', width: w, height: h };
  } catch {
    return { status: 'failed' };
  } finally {
    bitmap.close?.();
  }
}

/** Bytes as base64, in pieces so a large image doesn't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
