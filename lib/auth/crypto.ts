import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getSessionSecret } from '@/lib/auth/session-secret';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const MIN_SECRET_LENGTH = 32;

function getKey(): Buffer {
  const secret = getSessionSecret();
  if (!secret) throw new Error('SESSION_SECRET not configured');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return createHash('sha256').update(secret).digest();
}

export function encryptSession(serverUrl: string, username: string, password: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const payload = JSON.stringify({ v: 1, serverUrl, username, password });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSession(token: string): { serverUrl: string; username: string; password: string } | null {
  try {
    const key = getKey();
    const data = Buffer.from(token, 'base64');
    if (data.length < IV_LENGTH + TAG_LENGTH) return null;

    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString('utf8'));

    if (parsed.v !== 1 || !parsed.serverUrl || !parsed.username || !parsed.password) return null;
    return { serverUrl: parsed.serverUrl, username: parsed.username, password: parsed.password };
  } catch (error) {
    logger.warn('Session decryption failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * The purpose an encrypted payload was minted for.
 *
 * Several unrelated things travel as AES-256-GCM blobs under the same
 * SESSION_SECRET-derived key: the session context cookie, the OAuth pending
 * state, the pairing step-up proof, the office editor token. The purpose is
 * bound into the GCM tag as additional authenticated data, so a blob minted
 * for one of them cannot be opened on the path of another - the confusion
 * fails as a decryption error rather than as a validation check somebody has
 * to remember to write (GHSA-cqqx-mjcf-mh55).
 */
export type PayloadPurpose =
  /** jmap_stalwart_ctx - the signed-in user's Stalwart credentials. */
  | 'session-context'
  /** OAuth state + PKCE verifier, held between /sso/start and /sso/complete. */
  | 'sso-pending'
  /** Fresh-IdP-login proof required before a device pairing code is issued. */
  | 'pair-reauth'
  /** A paired phone's refresh token, renewed through the webmail's token proxy. */
  | 'pair-refresh'
  /** WOPI access token, scoped to one file node and a six-hour expiry. */
  | 'wopi-token'
  /** The app password an impersonation handoff minted, kept for revocation. */
  | 'impersonation-grant';

/**
 * Whether a blob minted before purposes were bound may be re-admitted for
 * `purpose`, recognised by the plaintext markers that version wrote.
 *
 * Without this, upgrading would log every user out; with it, an editor token
 * still cannot pass as a session cookie, because the WOPI mint has always
 * stamped `t: 'wopi'` and the session context has never carried a marker at
 * all. Removable once the pre-upgrade cookies have expired.
 */
const LEGACY_PAYLOAD_MARKERS: Record<PayloadPurpose, (payload: Record<string, unknown>) => boolean> = {
  'session-context': (p) => p.t === undefined && p.purpose === undefined,
  // `purpose: 'reauth'` distinguishes step-up from plain login within the SSO
  // flow; it predates these envelope purposes and is unrelated to them.
  'sso-pending': (p) => p.t === undefined && (p.purpose === undefined || p.purpose === 'reauth'),
  'pair-reauth': (p) => p.purpose === 'pair',
  'pair-refresh': () => false,
  'wopi-token': (p) => p.t === 'wopi',
  'impersonation-grant': () => false,
};

export function encryptPayload(payload: Record<string, unknown>, purpose: PayloadPurpose): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));

  // `p` restates the bound purpose in the plaintext. The GCM tag is what
  // actually confines the blob; this is the readable copy, checked on the way
  // back out so a mismatch surfaces even if a future caller opens the
  // envelope by hand.
  const json = JSON.stringify({ ...payload, p: purpose });
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function openEnvelope(data: Buffer, aad: PayloadPurpose | null): Record<string, unknown> | null {
  if (data.length < IV_LENGTH + TAG_LENGTH) return null;

  const key = getKey();
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (aad !== null) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const parsed: unknown = JSON.parse(decrypted.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Decrypt a payload minted for `purpose`. A blob minted for any other purpose
 * returns null, even though it is authentic under the same key.
 */
export function decryptPayload(token: string, purpose: PayloadPurpose): Record<string, unknown> | null {
  const data = Buffer.from(token, 'base64');

  try {
    const bound = openEnvelope(data, purpose);
    if (bound) return bound.p === purpose ? bound : null;
  } catch {
    // Not a blob bound to this purpose: either it belongs to another purpose,
    // it predates the binding, or it is forged. The legacy read below tells
    // the second case apart from the other two.
  }

  try {
    const legacy = openEnvelope(data, null);
    if (legacy && legacy.p === undefined && LEGACY_PAYLOAD_MARKERS[purpose](legacy)) {
      return legacy;
    }
  } catch (error) {
    logger.warn('Payload decryption failed', {
      purpose,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }

  logger.warn('Payload rejected: not minted for this purpose', { purpose });
  return null;
}
