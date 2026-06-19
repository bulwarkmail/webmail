import { createHash } from 'node:crypto';

// Pure helpers for the Libravatar resolver (app/api/libravatar/route.ts).
// Kept separate so they can be unit-tested without spinning up the route.

export const LIBRAVATAR_CENTRAL_HOST = 'seccdn.libravatar.org';

export const AVATAR_SIZE_MIN = 16;
export const AVATAR_SIZE_MAX = 512;
export const AVATAR_SIZE_DEFAULT = 80;

export const EMAIL_RE =
  /^[^\s@]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/i;

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export interface SrvTarget {
  host: string;
  port: number;
}

/** Lower-case + trim, per the Libravatar hashing spec. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** SHA-256 hex of the normalised address (Libravatar's recommended hash). */
export function emailHash(email: string): string {
  return createHash('sha256').update(normaliseEmail(email)).digest('hex');
}

/** Returns the domain for a valid address, else null. */
export function emailDomain(email: string): string | null {
  const m = EMAIL_RE.exec(email);
  return m ? m[1].toLowerCase() : null;
}

export function clampSize(raw: string | null | undefined): number {
  const n = raw ? parseInt(raw, 10) : AVATAR_SIZE_DEFAULT;
  if (Number.isNaN(n)) return AVATAR_SIZE_DEFAULT;
  return Math.min(AVATAR_SIZE_MAX, Math.max(AVATAR_SIZE_MIN, n));
}

/**
 * SSRF guard for a federation target resolved from an SRV record: must be a
 * public hostname (not localhost / *.local / *.internal / a bare IP).
 */
export function isPublicHost(host: string): boolean {
  if (!host || host.length > 253 || !HOST_RE.test(host)) return false;
  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.arpa') ||
    lower.endsWith('.localhost')
  ) {
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) return false;
  return true;
}

/**
 * Build the avatar URL. With a federated SRV target, query that server;
 * otherwise the central Libravatar CDN. `d=404` so a miss returns 404 and the
 * caller can fall back to a favicon / initials.
 */
export function buildAvatarUrl(target: SrvTarget | null, hash: string, size: number): string {
  const path = `/avatar/${hash}?s=${size}&d=404`;
  if (target) {
    const portPart = target.port === 443 ? '' : `:${target.port}`;
    return `https://${target.host}${portPart}${path}`;
  }
  return `https://${LIBRAVATAR_CENTRAL_HOST}${path}`;
}
