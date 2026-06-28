/**
 * Utilities for multi-account support:
 * - Account ID generation
 * - Deterministic avatar colors
 * - Account-scoped localStorage keys
 */

/** Generate a unique, deterministic account ID from username and server URL */
export function generateAccountId(username: string, serverUrl: string): string {
  try {
    const host = new URL(serverUrl).hostname;
    return `${username}@${host}`;
  } catch {
    // Relative URL (e.g. /api/dev-jmap) – use current origin as base
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const host = new URL(serverUrl, base).hostname;
    return `${username}@${host}`;
  }
}

/** Deterministic avatar/accent color from an email string */
export function generateAvatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
  }
  // 12 distinct, accessible hues
  const colors = [
    '#2563eb', // blue
    '#7c3aed', // violet
    '#db2777', // pink
    '#dc2626', // red
    '#ea580c', // orange
    '#d97706', // amber
    '#65a30d', // lime
    '#16a34a', // green
    '#0d9488', // teal
    '#0891b2', // cyan
    '#6366f1', // indigo
    '#9333ea', // purple
  ];
  return colors[Math.abs(hash) % colors.length];
}

/** Get initials for an avatar from a display name or email */
export function getInitials(name: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0][0]?.toUpperCase() ?? '?';
  }
  if (email) {
    return email[0]?.toUpperCase() ?? '?';
  }
  return '?';
}

/** Build an account-scoped localStorage key */
export function getAccountScopedKey(baseKey: string, accountId: string): string {
  return `${baseKey}::${accountId}`;
}

/**
 * Hard upper bound on cookie slots. Each slot can hold up to ~3 cookies
 * (session, refresh token, server id, auth context), so 50 slots ≈ 125
 * cookies on average - within Firefox's per-domain limit of 150.
 */
export const MAX_ACCOUNT_SLOTS = 50;

/**
 * UX cap for browsers using HTTP/1.1. Each account holds one persistent
 * SSE connection for JMAP push; HTTP/1.1 caps origins at 6 concurrent
 * connections, so 5 accounts leave one connection free for normal traffic.
 * On HTTP/2+ this cap doesn't apply because streams are multiplexed.
 */
export const MAX_ACCOUNTS_HTTP1 = 5;

/**
 * Detect whether the page has observed any HTTP/2 or HTTP/3 traffic.
 *
 * We walk recent resource-timing entries and treat a single h2/h3 sighting
 * as a positive signal. Cross-origin entries may report an empty
 * `nextHopProtocol` without `Timing-Allow-Origin`, in which case we
 * under-detect and fall back to the conservative cap - that's safe.
 */
export function isHttp2Available(): boolean {
  if (typeof performance === 'undefined') return false;
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const proto = entries[i].nextHopProtocol;
    if (proto === 'h2' || proto === 'h3') return true;
  }
  return false;
}

/**
 * Effective per-browser account cap. Lifts to {@link MAX_ACCOUNT_SLOTS}
 * once HTTP/2+ is observed, otherwise returns {@link MAX_ACCOUNTS_HTTP1}.
 */
export function getMaxAccounts(): number {
  return isHttp2Available() ? MAX_ACCOUNT_SLOTS : MAX_ACCOUNTS_HTTP1;
}

/** Minimal shape needed to order accounts (structural — avoids importing AccountEntry). */
export interface OrderableAccount {
  id: string;
  isDefault: boolean;
}

/**
 * Display order for the account switcher: the default account first, then the
 * remaining accounts in their stored order. Pure — does not mutate the input.
 */
export function sortDefaultFirst<T extends OrderableAccount>(accounts: T[]): T[] {
  const defaults = accounts.filter((a) => a.isDefault);
  const rest = accounts.filter((a) => !a.isDefault);
  return [...defaults, ...rest];
}

/**
 * Compute the new full account-id order after dragging `dragId` onto `overId`.
 * Default account(s) stay pinned to the front; only non-default accounts are
 * reordered (`dragId` is inserted at `overId`'s position among them).
 * Returns null when the move is a no-op or invalid (e.g. a default is involved).
 */
export function reorderNonDefaultIds(
  accounts: OrderableAccount[],
  dragId: string,
  overId: string,
): string[] | null {
  if (dragId === overId) return null;
  const defaults = accounts.filter((a) => a.isDefault).map((a) => a.id);
  const nonDefault = accounts.filter((a) => !a.isDefault).map((a) => a.id);
  const from = nonDefault.indexOf(dragId);
  const to = nonDefault.indexOf(overId);
  if (from < 0 || to < 0) return null;
  const [moved] = nonDefault.splice(from, 1);
  nonDefault.splice(to, 0, moved);
  return [...defaults, ...nonDefault];
}
