/**
 * WebAuthn with PRF, to wrap the lock key. There is no server in this: nothing checks
 * the assertion, and the challenge is only there because the API asks for one. What
 * counts is the 32 bytes the authenticator derives, without which the wrap can't open.
 *
 * A browser can't say ahead of time whether a new passkey has PRF, so it is tried right
 * after creating it. The PIN stays either way.
 */

import { randomBytes } from './crypto';

export class PasskeyNoPrfError extends Error {
  constructor() {
    super('This passkey has no PRF');
    this.name = 'PasskeyNoPrfError';
  }
}

interface PrfResults {
  enabled?: boolean;
  results?: { first?: ArrayBuffer };
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function passkeysPossible(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

function prfOf(credential: PublicKeyCredential): PrfResults | undefined {
  return (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;
}

/** The authenticator's answer for `salt`. Null when this one has no PRF. */
export async function passkeyPrf(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer | null> {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: buffer(randomBytes(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: buffer(credentialId) }],
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { eval: { first: buffer(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!credential) return null;
  return prfOf(credential)?.results?.first ?? null;
}

export interface NewPasskey {
  credentialId: Uint8Array;
  salt: Uint8Array;
  prfOutput: ArrayBuffer;
}

/** Throws PasskeyNoPrfError when the new passkey turns out to have no PRF. */
export async function createPasskey(appName: string): Promise<NewPasskey> {
  const salt = randomBytes(32);
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: appName, id: location.hostname },
      user: { id: buffer(randomBytes(16)), name: appName, displayName: appName },
      challenge: buffer(randomBytes(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
      timeout: 120_000,
      // Some authenticators only say they have PRF when asked with an input.
      extensions: { prf: { eval: { first: buffer(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new PasskeyNoPrfError();
  const credentialId = new Uint8Array(credential.rawId);
  const made = prfOf(credential);
  if (made?.enabled === false) throw new PasskeyNoPrfError();
  // Windows Hello and others only give the bytes on `get`, so ask once to be sure.
  const prfOutput = made?.results?.first ?? await passkeyPrf(credentialId, salt);
  if (!prfOutput) throw new PasskeyNoPrfError();
  return { credentialId, salt, prfOutput };
}
