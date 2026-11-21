/**
 * Mail accounts the admin names in the dashboard (`adminAccounts`) that get
 * into the Bulwark admin dashboard like a Stalwart superuser does, without
 * an admin role in Stalwart. Each entry is tied to one configured mail
 * server; `stalwartAdminAccess` decides what being listed grants.
 */
import { normalizeUrl, parseJmapServers } from './jmap-servers';

export interface AdminAccountEntry {
  serverUrl: string;
  account: string;
}

export const ADMIN_ACCOUNT_MAX_LENGTH = 256;

export const ADMIN_ACCOUNTS_INVALID_MESSAGE =
  'Each admin account needs an account name and one of the configured mail servers.';

/** The configured mail servers' URLs as written: the global one, then the list's. */
export function configuredServerUrls(jmapServerUrl: unknown, jmapServers: unknown): string[] {
  const urls: string[] = [];
  if (typeof jmapServerUrl === 'string' && jmapServerUrl.trim()) urls.push(jmapServerUrl.trim());
  for (const server of parseJmapServers(jmapServers)) urls.push(server.url);
  return urls;
}

/** The configured URL that `url` names, or undefined when it names none. */
function findConfiguredUrl(serverUrls: string[], url: string): string | undefined {
  const target = normalizeUrl(url);
  return serverUrls.find((u) => normalizeUrl(u) === target);
}

/**
 * The form two account names are compared in. Only ASCII letters fold:
 * `toLowerCase()` would also turn a Kelvin sign (U+212A) into "k", so a
 * mailbox named with one could pass for a listed "kim". A name with other
 * letters must match as written.
 */
function foldAccountName(name: string): string {
  return name.trim().replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

function entryKey(entry: AdminAccountEntry): string {
  return `${normalizeUrl(entry.serverUrl)}\0${foldAccountName(entry.account)}`;
}

/**
 * Check a submitted list. Returns null when any entry lacks an account name
 * or names a server that isn't configured; otherwise the entries with the
 * account trimmed, the server URL as configured, and duplicates dropped.
 */
export function sanitizeAdminAccounts(raw: unknown, serverUrls: string[]): AdminAccountEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: AdminAccountEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const e = item as Record<string, unknown>;
    const account = typeof e.account === 'string' ? e.account.trim() : '';
    if (!account || account.length > ADMIN_ACCOUNT_MAX_LENGTH) return null;
    const serverUrl = typeof e.serverUrl === 'string' ? findConfiguredUrl(serverUrls, e.serverUrl) : undefined;
    if (!serverUrl) return null;
    const entry = { serverUrl, account };
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * The stored list as it applies now: malformed entries and entries whose
 * server is no longer configured are left out.
 */
export function readAdminAccounts(raw: unknown, serverUrls: string[]): AdminAccountEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => sanitizeAdminAccounts([item], serverUrls) ?? []);
}

/**
 * Whether one of `names` is listed for `serverUrl`. The names must come from
 * the mail server's answer for the request's credential, never from what
 * the caller claims.
 */
export function isListedAdminAccount(
  entries: AdminAccountEntry[],
  serverUrl: string,
  names: ReadonlyArray<string | undefined>,
): boolean {
  const server = normalizeUrl(serverUrl);
  const wanted = names
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map(foldAccountName);
  if (wanted.length === 0) return false;
  return entries.some((e) => normalizeUrl(e.serverUrl) === server && wanted.includes(foldAccountName(e.account)));
}
