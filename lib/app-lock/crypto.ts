/**
 * The keys behind app lock, WebCrypto only.
 *
 * One random lock key wraps every account's database key (a layer in
 * lib/store/client/keys.ts). The lock key itself is only ever stored wrapped: once
 * under the PIN, and once for each other way in (a passkey's PRF, the desktop app's
 * OS storage). So a new account needs no PIN, and a changed PIN touches one record.
 */

import type { WrapLayer } from '@/lib/store/client/keys';

export const LOCK_LAYER = 'applock';
export const SHELL_LAYER = 'safeStorage';
/** OWASP's floor for PBKDF2-HMAC-SHA256. A wrong guess costs this much, online or off. */
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PIN_LENGTH = 6;

const AES = { name: 'AES-GCM', length: 256 } as const;
const PRF_INFO = new TextEncoder().encode('bulwark-app-lock-prf-v1');
const PROOF_INFO = new TextEncoder().encode('bulwark-app-lock-main-proof-v1');
const PIN_STEP_INFO = new TextEncoder().encode('bulwark-app-lock-pin-step-v1');

export interface WrappedBytes {
  iv: Uint8Array;
  data: Uint8Array;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** The same PIN typed on another keyboard or OS gives the same bytes. */
export function pinBytes(pin: string): Uint8Array {
  return new TextEncoder().encode(pin.normalize('NFKC'));
}

export function pinLongEnough(pin: string): boolean {
  return [...pin.normalize('NFKC')].length >= MIN_PIN_LENGTH;
}

/** A few of what people pick most, as the check below reads them. Runs and repeats are found by rule. */
const COMMON_PINS = new Set([
  'password', 'password1', 'password123', 'passwort', 'qwerty', 'qwertz', 'qwerty123', 'qwertyuiop', 'asdfgh', 'yxcvbn', 'zxcvbn',
  '1q2w3e', '1q2w3e4r', 'q1w2e3', 'abc123', 'a1b2c3', '123abc', 'letmein', 'iloveyou', 'admin123', 'welcome', 'welcome1', 'monkey', 'dragon',
  '147258', '159753', '258456', '789456', '102030', '101010', '696969', '111222', '121314', '131313', '123321', '112233',
]);

/** Digits go round, as on a keypad: 7890123. */
function allSameStep(chars: string[], step: number): boolean {
  return chars.every((char, index) => {
    if (index === 0) return true;
    const distance = char.codePointAt(0)! - chars[index - 1].codePointAt(0)!;
    const digits = /\d/.test(char) && /\d/.test(chars[index - 1]);
    return distance === step || (digits && (distance + 10) % 10 === (step + 10) % 10);
  });
}

/** Refused when a PIN is set. Someone with the disk tries exactly these first, and PBKDF2 can't help with those. */
export function pinIsObvious(pin: string): boolean {
  const chars = [...pin.normalize('NFKC').toLowerCase()];
  if (COMMON_PINS.has(chars.join(''))) return true;
  if (allSameStep(chars, 0) || allSameStep(chars, 1) || allSameStep(chars, -1)) return true;
  // 121212, 123123, abcabc: a short piece over and over.
  for (let size = 1; size <= 3; size += 1) {
    if (chars.length >= size * 2 && chars.every((char, index) => char === chars[index % size])) return true;
  }
  return false;
}

export class ObviousPinError extends Error {
  constructor() {
    super('That PIN is too easy to guess');
    this.name = 'ObviousPinError';
  }
}

/** Slow on purpose. Not extractable: it only ever wraps the lock key. */
export async function keyFromPin(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buffer(pinBytes(pin)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations },
    base,
    AES,
    false,
    ['encrypt', 'decrypt'],
  );
}

/** What goes to main for a PIN guess: the slow part, done here. Nobody needs to see the PIN itself. */
export async function bitsFromPin(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', buffer(pinBytes(pin)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations }, base, 256));
}

/** The key under the PIN from what main made of a guess, with a secret only it has. */
export async function keyFromPinStep(bytes: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buffer(bytes), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: PIN_STEP_INFO },
    base,
    AES,
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A key from what an authenticator's PRF gave: 32 bytes that only it can make again. */
export async function keyFromPrf(output: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
  const base = await crypto.subtle.importKey('raw', buffer(bytes), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: PRF_INFO },
    base,
    AES,
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key: CryptoKey, plain: Uint8Array): Promise<WrappedBytes> {
  const iv = randomBytes(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(iv) }, key, buffer(plain)));
  return { iv, data };
}

/** Throws when the key is the wrong one: that's how a wrong PIN shows. */
export async function open(key: CryptoKey, wrapped: WrappedBytes): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(wrapped.iv) }, key, buffer(wrapped.data)));
}

/**
 * What shows the desktop app's main process that someone really unlocked: only the lock
 * key's bytes give it, and they exist only just after a real unlock. Main keeps a hash.
 */
export async function mainProof(raw: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', buffer(raw), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: PROOF_INFO },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** The lock key for use. It can wrap and unwrap, and can't be read back out. */
export function importLockKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buffer(raw), AES, false, ['encrypt', 'decrypt']);
}

/** The layer around each account's database key. The IV goes in front of the bytes. */
export function lockLayer(key: CryptoKey): WrapLayer {
  return {
    name: LOCK_LAYER,
    async wrap(data) {
      const iv = randomBytes(12);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(iv) }, key, buffer(data)));
      const out = new Uint8Array(iv.length + sealed.length);
      out.set(iv);
      out.set(sealed, iv.length);
      return out;
    },
    async unwrap(data) {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(data.slice(0, 12)) }, key, buffer(data.slice(12)));
      return new Uint8Array(plain);
    },
  };
}
