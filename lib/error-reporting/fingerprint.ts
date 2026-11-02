import type { Frame } from './stack';

/** How many of the top frames make up a fingerprint. */
export const FINGERPRINT_FRAMES = 5;

/**
 * 64-bit FNV-1a as 16 hex digits. Synchronous and the same in the browser and
 * on the server; not for security, only for grouping.
 */
export function hash64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * The fingerprint of an error: its name, the top frames (file without origin,
 * line, column) and the Bulwark version. The same error in another release is
 * another fingerprint, because its frames point into other chunks anyway.
 * `code` is one of Bulwark's fixed error codes (a JMAP error type), for
 * errors that are all raised from the same place.
 */
export function fingerprint(name: string, frames: readonly Frame[], version: string, code?: string): string {
  const top = frames
    .filter((frame) => frame.path !== '[other]')
    .slice(0, FINGERPRINT_FRAMES)
    .map((frame) => `${frame.path}:${frame.line ?? ''}:${frame.column ?? ''}`);
  return hash64([name, code ?? '', ...top, version].join('|'));
}
