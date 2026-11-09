import { scrubRoutePath } from '@/lib/route-groups';
import { scrubText } from '@/lib/error-reporting/scrub';

/**
 * What a span may carry before it leaves this server: no user names, mail
 * addresses, tokens, query strings or paths that name folders, messages or
 * files. Next's own spans and ours go through it.
 *
 * - absolute URLs keep their origin only (a Stalwart download URL ends in
 *   the attachment's file name)
 * - request paths become their route group (`/mail/…`)
 * - query, fragment, user agent and client address attributes are dropped
 * - any other text with an address or a credential is scrubbed
 *
 * https://bulwarkmail.org/docs/deployment/monitoring#tracing
 */

type AttributeValue = string | number | boolean | Array<string | number | boolean | null | undefined> | undefined;
export type Attributes = Record<string, AttributeValue>;

const DROP = /^(?:url\.query|url\.fragment|http\.user_agent|user_agent\.|enduser\.|client\.address|client\.port|http\.client_ip|net\.peer\.ip|net\.sock\.peer\.addr|network\.peer\.address|http\.request\.header\.|http\.response\.header\.|db\.statement)/;
const PATH_KEYS = new Set(['http.target', 'url.path', 'next.page.path']);
const URL_IN_TEXT = /\b(https?):\/\/([^/\s?#"'<>]+)[^\s"'<>]*/gi;
const METHOD_AND_PATH = /\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/[^\s]*)/g;

/** A path from the request: keep route patterns (`/api/admin/[id]`), reduce anything else to its group. */
function safePath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0];
  return bare.includes('[') && /^[\w/[\].()-]+$/.test(bare) ? bare : scrubRoutePath(bare);
}

/** A span name: URLs reduced to their origin, request paths to their group. */
export function scrubSpanName(name: string): string {
  return name
    .replace(URL_IN_TEXT, (_match, scheme: string, host: string) => `${scheme.toLowerCase()}://${host}`)
    .replace(METHOD_AND_PATH, (_match, method: string, path: string) => `${method} ${safePath(path)}`);
}

function scrubString(key: string, value: string): string {
  if (PATH_KEYS.has(key)) return safePath(value);
  if (/@|bearer |basic |eyJ|:\/\//i.test(value)) {
    return value.replace(URL_IN_TEXT, (_m, scheme: string, host: string) => `${scheme.toLowerCase()}://${host}`)
      .split(/\s+/).map((word) => (/@|eyJ/.test(word) ? scrubText(word) : word)).join(' ')
      .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [token]');
  }
  return value;
}

/** Scrub span attributes in place (the processor runs it before export). */
export function scrubAttributes(attributes: Attributes): void {
  for (const key of Object.keys(attributes)) {
    if (DROP.test(key)) {
      delete attributes[key];
      continue;
    }
    const value = attributes[key];
    if (typeof value === 'string') attributes[key] = scrubString(key, value);
    else if (Array.isArray(value)) attributes[key] = value.map((v) => (typeof v === 'string' ? scrubString(key, v) : v));
  }
}
