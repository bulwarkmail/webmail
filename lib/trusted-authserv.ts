/**
 * The mail servers, besides the receiving Stalwart, whose
 * Authentication-Results the sender check acts on (TRUSTED_AUTHSERV_IDS,
 * "Trusted mail servers" in the admin dashboard). RFC 8601 section 7.1 lets
 * a reader act only on results from an authserv-id it trusts. Without this
 * list that is the Stalwart that took the message in, recognised from its
 * own Received line (lib/email-headers.ts authenticationResultsOnReceipt).
 * Other JMAP servers, Gmail or an IMAP server behind legacy-proxy, and a
 * filtering gateway in front of Stalwart write their results under their own
 * name, which only the admin can vouch for.
 *
 * The server reads the setting and hands it to the browser through
 * /api/config (Lite: config.json); fetchConfig() stores it here, where the
 * header checks read it, so every message fetch judges by the same list.
 */

/** A hostname: letters, digits and hyphens in dot-separated labels. No wildcards. */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** One entry as the checks compare it: lower case, without a trailing dot. */
function normalise(entry: string): string {
  return entry.trim().toLowerCase().replace(/\.$/, '');
}

function entries(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[\s,]+/);
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

/**
 * The entries of a setting value (comma- or space-separated, or a list)
 * that aren't hostnames, as written, for the admin API to refuse.
 */
export function invalidTrustedAuthservIds(value: unknown): string[] {
  return entries(value)
    .filter((entry) => entry.trim() !== '')
    .filter((entry) => !HOSTNAME_RE.test(normalise(entry)));
}

/**
 * The trusted hostnames in a setting value, lower case, without a trailing
 * dot or duplicates. Anything that isn't a hostname is left out: an entry
 * such as `*.example.com` trusts nothing.
 */
export function parseTrustedAuthservIds(value: unknown): string[] {
  const ids = entries(value).map(normalise).filter((entry) => HOSTNAME_RE.test(entry));
  return [...new Set(ids)];
}

let trusted: readonly string[] = [];

/** Called once the runtime config is known. */
export function setTrustedAuthservIds(value: unknown): void {
  trusted = parseTrustedAuthservIds(value);
}

/** The configured list; empty until the config has been read, or when none is set. */
export function trustedAuthservIds(): readonly string[] {
  return trusted;
}
