/**
 * Credentials between windows, sealed for the window that asked. The request
 * carries a throwaway public key, and the answer can only be opened with the
 * private key, which is not extractable and never leaves that window. So a
 * listener on the channel, such as a privileged plugin frame, hears no
 * credential go by.
 *
 * A BroadcastChannel has no way to hand over a MessagePort, and a window the
 * desktop bridge opens has no opener to send one through.
 */

export function canSealSessions(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const AES = { name: 'AES-GCM', length: 256 } as const;

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface SealedAnswer {
  publicKey: JsonWebKey;
  iv: string;
  data: string;
}

export interface SessionOpener {
  publicKey: JsonWebKey;
  open<T>(sealed: SealedAnswer): Promise<T>;
}

async function deriveKey(privateKey: CryptoKey, peer: JsonWebKey): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey('jwk', peer, ECDH, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, AES, false, ['encrypt', 'decrypt']);
}

/** The asking window's side: a key to send along, and what opens the answer. */
export async function createSessionOpener(): Promise<SessionOpener> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveKey']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    publicKey,
    async open<T>(sealed: SealedAnswer): Promise<T> {
      const key = await deriveKey(pair.privateKey, sealed.publicKey);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    },
  };
}

/** The answering window's side. */
export async function sealFor(requester: JsonWebKey, value: unknown): Promise<SealedAnswer> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveKey']);
  const key = await deriveKey(pair.privateKey, requester);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), iv: toBase64(iv), data: toBase64(data) };
}

/** Says which credential the server refused without saying what it is. */
export async function credentialFingerprint(header: string): Promise<string> {
  return toBase64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(header)));
}
