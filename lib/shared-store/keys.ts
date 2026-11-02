import { createHash } from 'node:crypto';
import { InvalidStoreKeyError } from './types';

// One path segment: letters, digits and . _ @ + ~ -, but never "." or "..".
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._@+~-]{1,200}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A document id: one or more segments joined by "/". Throws on anything else. */
export function assertDocId(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024) throw new InvalidStoreKeyError(String(id));
  for (const segment of id.split('/')) {
    if (!SEGMENT.test(segment)) throw new InvalidStoreKeyError(id);
  }
}

/** A collection, log or lease name. */
export function assertName(name: string): void {
  if (!NAME.test(name)) throw new InvalidStoreKeyError(name);
}

/** A kv or counter key: anything printable without control characters, at most 512 chars. */
export function assertKey(key: string): void {
  // eslint-disable-next-line no-control-regex
  if (typeof key !== 'string' || key.length === 0 || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new InvalidStoreKeyError(String(key));
  }
}

/** The version of a document: changes whenever its bytes do. */
export function versionOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64url').slice(0, 22);
}

export function toBuffer(data: Buffer | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}
