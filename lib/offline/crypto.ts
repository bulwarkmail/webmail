/**
 * Encryption at rest for offline mode (#523): AES-GCM with a 256-bit key
 * the browser generates as non-extractable and keeps in the offline
 * database. Script on this origin can't read the key's bytes, only use it.
 *
 * What it protects against: someone who copies the browser profile's files
 * (a backup, a stolen disk image) without being able to run this site in
 * that profile. What it doesn't: someone using the unlocked browser profile,
 * or a script running on this origin, can decrypt everything. The docs say
 * so and recommend disk encryption.
 */

import { idbGet, idbWrite } from './db';

export interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

let keyPromise: Promise<CryptoKey> | null = null;

async function loadOrCreateKey(): Promise<CryptoKey> {
  const stored = await idbGet<{ id: string; key: CryptoKey }>('keys', 'aes');
  if (stored?.key) return stored.key;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idbWrite([{ store: 'keys', put: { id: 'aes', key } }]);
  return key;
}

function deviceKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = loadOrCreateKey();
    keyPromise.catch(() => { keyPromise = null; });
  }
  return keyPromise;
}

/** Forget the key in memory (the database with it was deleted). */
export function forgetDeviceKey(): void {
  keyPromise = null;
}

export async function sealBytes(bytes: ArrayBuffer | Uint8Array): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), bytes as BufferSource);
  return { iv, data };
}

export async function openBytes(sealed: Sealed): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as BufferSource }, await deviceKey(), sealed.data);
}

export async function sealJson(value: unknown): Promise<Sealed> {
  return sealBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export async function openJson<T>(sealed: Sealed): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await openBytes(sealed))) as T;
}
