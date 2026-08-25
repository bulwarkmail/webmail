/**
 * Browser side of the Sidebar Apps CSP handshake. See
 * `lib/security/app-frame-origins.ts` for why the cookie exists.
 */

import { getPathPrefix } from '@/lib/browser-navigation';
import {
  APP_FRAME_ORIGINS_COOKIE,
  parseAppFrameOrigins,
  serializeAppFrameOrigins,
} from './app-frame-origins';

function readRawCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** Origins currently advertised to the proxy, validated. */
export function readAppFrameOrigins(): string[] {
  return parseAppFrameOrigins(readRawCookie(APP_FRAME_ORIGINS_COOKIE));
}

/**
 * Publishes the origins for the proxy to merge into `frame-src`. Returns
 * whether the write actually landed - if cookies are blocked it returns false
 * and callers must not wait for a CSP that will never widen.
 */
export function writeAppFrameOrigins(origins: ReadonlyArray<string>): boolean {
  if (typeof document === 'undefined') return false;
  const value = serializeAppFrameOrigins(origins);
  const attrs = [
    `${APP_FRAME_ORIGINS_COOKIE}=${value}`,
    `path=${getPathPrefix() || '/'}`,
    'max-age=31536000',
    'samesite=lax',
  ];
  if (window.location.protocol === 'https:') attrs.push('secure');
  document.cookie = attrs.join('; ');
  return readRawCookie(APP_FRAME_ORIGINS_COOKIE) === value;
}
