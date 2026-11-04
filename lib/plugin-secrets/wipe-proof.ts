/**
 * Proof that this browser had a session for an account, for the desktop app.
 *
 * An account the app dropped has no session cookie left, and its plugin secrets
 * still sit on this device until a wipe. So when a signed-in account stores or lists
 * them, it also gets this sealed cookie, and a wipe by name needs the one for that
 * name. Nobody can then clear an account's secrets by knowing its address.
 *
 * It opens nothing else, and only the desktop build writes or reads it.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { userKey, type VaultUser } from './vault';

/** Chromium's upper limit. A dropped account can stay dropped for a long time. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function cookieName(key: string): string {
  return `jmap_psp_${key.slice(0, 16)}`;
}

export function setWipeProof(response: NextResponse, user: VaultUser): void {
  const key = userKey(user);
  response.cookies.set(cookieName(key), encryptPayload({ u: key }, 'plugin-wipe-proof'), { ...getCookieOptions(), maxAge: MAX_AGE_SECONDS });
}

export function clearWipeProof(response: NextResponse, user: VaultUser): void {
  response.cookies.set(cookieName(userKey(user)), '', { ...getCookieOptions(), maxAge: 0 });
}

export function hasWipeProof(request: NextRequest, user: VaultUser): boolean {
  const key = userKey(user);
  const value = request.cookies.get(cookieName(key))?.value;
  if (!value) return false;
  try {
    return decryptPayload(value, 'plugin-wipe-proof')?.u === key;
  } catch {
    return false;
  }
}
