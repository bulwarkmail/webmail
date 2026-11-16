import { AuthenticationResults } from './jmap/types';
import { parseUnsubscribeUrls } from './validation';
import { toAsciiDomain } from './idn';
import { trustedAuthservIds } from './trusted-authserv';

type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
type SpfEntry = NonNullable<NonNullable<AuthenticationResults['spf']>['all']>[number];

/**
 * Severity ranking for SPF results. Higher = more severe / more actionable.
 * A hard `fail` is a definitive policy violation and must outrank ambiguous
 * states like `temperror`, so a spoofed message isn't softened to a
 * "temporary failure" headline when one identity hard-fails.
 */
const SPF_SEVERITY: Record<SpfResult, number> = {
  fail: 6,
  softfail: 5,
  permerror: 4,
  temperror: 3,
  neutral: 2,
  none: 1,
  pass: 0,
};

/**
 * Whether the authentication results indicate the visible From identity can't
 * be trusted (i.e. the message is likely spoofed). Used to suppress UI that
 * would otherwise imply the message legitimately came from one of the user's
 * own identities (e.g. the "via <identity>" badge).
 */
export function isAuthenticationSpoofed(auth?: AuthenticationResults): boolean {
  if (!auth) return false;
  // DMARC aligns the visible From with SPF/DKIM, so a DMARC fail is the
  // strongest single spoofing signal.
  if (auth.dmarc?.result === 'fail') return true;
  // Otherwise a hard SPF fail with no valid DKIM signature means the sender
  // isn't authorized for the envelope domain.
  if (auth.spf?.result === 'fail' && !hasDkimPass(auth)) return true;
  return false;
}

function hasDkimPass(auth: AuthenticationResults): boolean {
  return auth.dkim?.result === 'pass' || !!auth.dkim?.all?.some((entry) => entry.result === 'pass');
}

/**
 * Whether `candidate` is the From domain or a parent/child of it: the
 * relaxed alignment DMARC applies, without a public-suffix list.
 */
function alignedWith(fromDomain: string, candidate: string | undefined): boolean {
  const other = candidate ? domainOf(`@${candidate}`) : undefined;
  if (!other) return false;
  return other === fromDomain || other.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${other}`);
}

/**
 * An SPF pass for the MAIL FROM identity whose domain aligns with the From
 * domain. Any sender can pass SPF for a domain of their own and still write
 * someone else's address in From; only an aligned pass says anything about
 * the visible sender. A HELO pass never does.
 */
function hasAlignedSpfPass(auth: AuthenticationResults, fromDomain: string): boolean {
  if (auth.spf?.all) {
    return auth.spf.all.some((entry) => entry.identity !== 'helo' && entry.result === 'pass' && alignedWith(fromDomain, entry.domain));
  }
  return auth.spf?.result === 'pass' && alignedWith(fromDomain, auth.spf.domain);
}

/** A DKIM pass for a signing domain that aligns with the From domain. */
function hasAlignedDkimPass(auth: AuthenticationResults, fromDomain: string): boolean {
  const entries = auth.dkim?.all ?? (auth.dkim ? [auth.dkim] : []);
  return entries.some((entry) => entry.result === 'pass' && alignedWith(fromDomain, entry.domain));
}

/**
 * Whether the receiving server's checks tie the message to the visible From
 * domain: an aligned DMARC, SPF or DKIM pass. Shared by the sender
 * verification notice and the calendar invitation trust assessment.
 */
export function hasAlignedAuthenticationPass(auth: AuthenticationResults | undefined, fromEmail: string | undefined): boolean {
  if (!auth || !fromEmail) return false;
  const domain = domainOf(fromEmail);
  if (!domain) return false;
  return auth.dmarc?.result === 'pass' || hasAlignedSpfPass(auth, domain) || hasAlignedDkimPass(auth, domain);
}

function domainOf(address: string): string | undefined {
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
  return /^[^\s<>@]+\.[^\s<>@]+$/.test(domain) ? domain : undefined;
}

/**
 * The original envelope domain of a Sender Rewriting Scheme address, or
 * undefined when `address` isn't one. A forwarder rewrites
 * `user@orig.example` to `SRS0=hash=tt=orig.example=user@forwarder`, and a
 * second forwarder to `SRS1=hash=forwarder==hash=tt=orig.example=user@...`.
 * Only the leading fields are split off: the local part may contain `=`.
 */
function srsOriginalDomain(address: string): string | undefined {
  const at = address.lastIndexOf('@');
  if (at < 0) return undefined;
  const fields = address.slice(0, at).split('=');
  const tag = fields[0].toUpperCase();
  // SRS0: tag, hash, timestamp, domain, local part...
  // SRS1: tag, hash, first forwarder, '', hash, timestamp, domain, local part...
  const index = tag === 'SRS0' ? 3 : tag === 'SRS1' && fields[3] === '' ? 6 : -1;
  if (index < 0 || fields.length <= index + 1) return undefined;
  return domainOf(`@${fields[index]}`);
}

export interface SenderVerification {
  /**
   * `failed`: the message fails the From domain's checks (see
   * isAuthenticationSpoofed). `unverified`: neither SPF nor DKIM passes, so
   * nothing ties the message to any domain, let alone the one in From.
   */
  status: 'failed' | 'unverified';
  /** Domain of the visible From address. */
  domain: string;
  /** Envelope (MAIL FROM) host, when it differs from `domain`. */
  sentFrom?: string;
}

/**
 * Whether the receiving server's checks back the visible From domain.
 * Returns null when they do, or when there are no results to judge by.
 *
 * DMARC alone can't answer this: mail-auth (Stalwart) only checks alignment
 * once SPF or DKIM passes, so a message that passes neither reports
 * `dmarc=none` even when the From domain publishes a policy. That is the
 * plainest kind of forgery, so it gets its own verdict here.
 */
export function getSenderVerification(
  auth: AuthenticationResults | undefined,
  fromEmail: string | undefined,
): SenderVerification | null {
  if (!auth || !fromEmail || (!auth.spf && !auth.dkim && !auth.dmarc)) return null;
  const domain = domainOf(fromEmail);
  if (!domain) return null;

  // Name the sender by a passing DKIM signature first: it survives
  // forwarding, where the envelope is the forwarder's. Otherwise use the
  // MAIL FROM identity (a HELO pass proves nothing about who wrote the
  // message), decoding an SRS rewrite back to the original envelope domain.
  const dkimPass = (auth.dkim?.all ?? (auth.dkim ? [auth.dkim] : []))
    .find((entry) => entry.result === 'pass' && entry.domain);
  const mailFrom = auth.spf?.all?.find((entry) => entry.identity === 'mailfrom');
  const envelope = mailFrom?.domain ?? auth.spf?.domain;
  const senderDomain = dkimPass?.domain
    ? domainOf(`@${dkimPass.domain}`)
    : envelope ? srsOriginalDomain(envelope) ?? domainOf(envelope) : undefined;
  const sentFrom = senderDomain && senderDomain !== domain ? senderDomain : undefined;

  if (isAuthenticationSpoofed(auth)) return { status: 'failed', domain, sentFrom };
  // Only a pass that aligns with the From domain counts: `spf=pass` for the
  // sender's own envelope domain under someone else's From is the forgery
  // this notice exists for, and a DKIM signature by a third domain is no
  // better. The DMARC verdict is `none` in both cases (no policy published).
  if (hasAlignedAuthenticationPass(auth, fromEmail)) return null;
  return { status: 'unverified', domain, sentFrom };
}

/**
 * `with` protocols (RFC 3848) that record an authenticated submission: the
 * client handed the message in after logging in, so whatever
 * Authentication-Results it carries below that hop are the client's own text.
 */
const SUBMISSION_PROTOCOL_RE = /\bwith\s+(?:UTF8)?(?:E?SMTP|LMTP)S?A\b/i;

/**
 * The host a Received line names as Stalwart's: Stalwart writes
 * `by <hostname> (Stalwart SMTP) with ...` for mail it takes in over SMTP
 * and for what its Sieve scripts generate, and the same hostname opens its
 * Authentication-Results header. Nothing but `with <protocol> id <id>` and
 * the date follow that clause, so it must end the line: a HELO name or an
 * envelope address that another server copies into its own line can spell
 * the same words, but never in the place of that server's id and date.
 * Lower case, without a trailing dot.
 */
const STALWART_RECEIVED_RE = /\bby\s+([^\s;()]+)\s+\(Stalwart SMTP\)\s+with\s+[a-z0-9]+\s+id\s+[a-z0-9]+\s*(?:;[^;]*)?$/i;

function stalwartReceivedHost(value: string): string | undefined {
  const host = STALWART_RECEIVED_RE.exec(value)?.[1];
  return host ? host.toLowerCase().replace(/\.$/, '') : undefined;
}

/**
 * The authserv-id an Authentication-Results header opens with (RFC 8601
 * 2.2), lower case and without a version. Undefined when the header opens
 * with a result instead, as some Microsoft 365 hops write it.
 */
export function authservId(value: string | undefined): string | undefined {
  const first = value ? splitResinfo(value)[0] : undefined;
  if (!first || METHOD_RE.test(first)) return undefined;
  const id = first.split(/\s+/)[0].replace(/^"(.*)"$/, '$1').toLowerCase().replace(/\.$/, '');
  return id && !id.includes('=') ? id : undefined;
}

/**
 * Whether a Received line, the topmost of a message, records Stalwart taking
 * the message in from outside, and names the host the given
 * Authentication-Results header was written by.
 */
function receivedByAuthservHost(received: string, results: string | undefined): boolean {
  if (SUBMISSION_PROTOCOL_RE.test(received)) return false;
  const host = stalwartReceivedHost(received);
  return host !== undefined && host === authservId(results);
}

/**
 * What a Received line says of itself, with its comments and its date left
 * out (a HELO name, a reverse DNS name or an ASN name in a comment can spell
 * anything): whether it has a `from` clause, which a server writes when it
 * takes a message in from another one (RFC 5321 4.4), and the host its `by`
 * clause names, lower case and without a trailing dot.
 */
function receivedClauses(value: string): { from: boolean; by?: string } {
  const end = value.lastIndexOf(';');
  let text = end >= 0 ? value.slice(0, end) : value;
  for (let previous = ''; previous !== text;) {
    previous = text;
    text = text.replace(/\([^()]*\)/g, ' ');
  }
  const by = /(?:^|\s)by\s+([^\s;]+)/i.exec(text)?.[1];
  return {
    from: /^\s*from\s/i.test(text),
    by: by ? by.toLowerCase().replace(/\.$/, '') : undefined,
  };
}

/**
 * Whether a Received line above a trusted server's Authentication-Results
 * was written after that server checked the message, on its way into this
 * mailbox: by the receiving Stalwart (`ownHost`, the one whose line is on
 * top), by a server in the trusted list, or as a handoff inside a server
 * that names no other server it came from (Gmail's own top lines read
 * `by 2002:a05:... with SMTP id ...`). Any server outside the list that
 * took the message in from another one writes a `from` clause with its own
 * name after `by`, and below it the sender may have written anything. An
 * authenticated submission never counts.
 */
function trustedHop(received: string, trusted: ReadonlySet<string>, ownHost: string | undefined): boolean {
  if (SUBMISSION_PROTOCOL_RE.test(received)) return false;
  const stalwart = stalwartReceivedHost(received);
  if (stalwart !== undefined && (stalwart === ownHost || trusted.has(stalwart))) return true;
  const { from, by } = receivedClauses(received);
  if (!from) return true;
  return by !== undefined && trusted.has(by);
}

/**
 * Whether results with these Received lines above them (in message order)
 * count: the receiving Stalwart's own, or those of a server in the trusted
 * list with only trusted hops (trustedHop) above them.
 */
function resultsOnReceipt(above: readonly string[], results: string, trusted: readonly string[]): boolean {
  if (above.length === 0) return false;
  if (above.every((line) => receivedByAuthservHost(line, results))) return true;
  const id = authservId(results);
  const list = new Set(trusted);
  if (id === undefined || !list.has(id)) return false;
  const ownHost = stalwartReceivedHost(above[0]);
  return above.every((line) => trustedHop(line, list, ownHost));
}

/**
 * Whether the topmost Authentication-Results header was written by the
 * server that received the message into this mailbox. RFC 8601 (sections 5
 * and 7.1) lets a reader act only on results from an authserv-id it
 * trusts: anyone can write this header into a message, the sender's own
 * servers do on internal hops, and a mailbox filled over IMAP or from a
 * relay that writes none holds only such headers. Without a configured
 * list, the one id this client can trust is the receiving Stalwart's, which
 * writes its Received line on top of the message and its
 * Authentication-Results right below it, both with its hostname. So: every
 * Received line above the topmost Authentication-Results must be Stalwart's
 * for one and the same host (a Sieve redirect adds a second one), not an
 * authenticated submission, and the header's authserv-id must be that host.
 * Mail another server took in has that server's Received line on top, which
 * the sender can't put anything above. Takes the headers in message order.
 *
 * The admin can trust more servers (TRUSTED_AUTHSERV_IDS,
 * lib/trusted-authserv.ts): another JMAP server, a mailbox behind
 * legacy-proxy, a filtering gateway that relays to Stalwart. Their results
 * count when they are the topmost Authentication-Results, the authserv-id
 * is in the list and every Received line above them is a trusted hop
 * (trustedHop): a header with a listed name below a server outside the list
 * may be the sender's own. A gateway's results are only topmost when
 * Stalwart writes none of its own for what the gateway relays.
 *
 * This only catches a forged header on its own. Stalwart (0.16 and 1.0)
 * keeps both headers when a signed-in user writes them into a mail they
 * submit over JMAP, and adds nothing above them, so a forged Received line
 * followed by a forged "dkim=pass" arrives exactly like mail from outside.
 * Only the server can tell them apart.
 */
export function authenticationResultsOnReceipt(
  headers: readonly { name: string; value: string }[],
  trusted: readonly string[] = trustedAuthservIds(),
): boolean {
  const index = headers.findIndex((header) => header.name.toLowerCase() === 'authentication-results');
  if (index < 0) return false;
  const above = headers.slice(0, index)
    .filter((header) => header.name.toLowerCase() === 'received')
    .map((header) => header.value);
  return resultsOnReceipt(above, headers[index].value, trusted);
}

/**
 * The same check for a list row, which gets each header's instances apart
 * (`header:Received:all`, `header:Authentication-Results:all`, both in
 * message order) and so can't see which comes first: the topmost Received
 * line must be the receiving Stalwart's, for the host the topmost
 * Authentication-Results header names, or a trusted hop (trustedHop) when
 * that header's authserv-id is in the trusted list. A forged header that
 * passes this can only take a warning off the row, which a header the check
 * turns down does too.
 */
export function topAuthenticationResultsOnReceipt(
  received: readonly string[],
  results: readonly string[],
  trusted: readonly string[] = trustedAuthservIds(),
): boolean {
  return received.length > 0 && results.length > 0 && resultsOnReceipt(received.slice(0, 1), results[0], trusted);
}

/**
 * The keyword the mail import sets on every message it puts into the
 * mailbox from a file (lib/mail-import). The server stores such a message
 * as the file has it, Received and Authentication-Results lines included,
 * and never checked it itself.
 */
export const IMPORTED_KEYWORD = '$imported';

/** Whether the message came into the mailbox from an imported file (IMPORTED_KEYWORD). */
export function isImportedMessage(email: { keywords?: Record<string, boolean> | null } | undefined): boolean {
  return email?.keywords?.[IMPORTED_KEYWORD] === true;
}

/** The headers of a message when they are the list in message order (as Email/get returns `headers`). */
function headersInOrder(headers: unknown): { name: string; value: string }[] | undefined {
  if (!Array.isArray(headers)) return undefined;
  return headers.every((header) => typeof header?.name === 'string' && typeof header?.value === 'string')
    ? headers as { name: string; value: string }[]
    : undefined;
}

/**
 * What the message itself shows about its results: true or false from the
 * flag the full fetch sets (authenticationResultsOnReceipt), else from the
 * headers in message order when it carries them (a conversation's messages
 * do), else undefined: nothing to go by (a list row, a search result).
 */
export function authenticationResultsEvidence(
  email: { authenticationResultsOnReceipt?: unknown; headers?: unknown } | undefined,
): boolean | undefined {
  if (!email) return undefined;
  if (email.authenticationResultsOnReceipt !== undefined) return email.authenticationResultsOnReceipt === true;
  const headers = headersInOrder(email.headers);
  return headers ? authenticationResultsOnReceipt(headers) : undefined;
}

/**
 * Whether a pass in the message's Authentication-Results may earn it
 * anything. Only on evidence that the results were written on receipt
 * (authenticationResultsEvidence): without it the answer is no, and it is
 * always no for a message from an imported file, whose headers this server
 * never wrote. The sender logo, the invitation trust and the booking cards
 * all ask this.
 */
export function authenticationResultsUsable(
  email: {
    authenticationResultsOnReceipt?: boolean;
    keywords?: Record<string, boolean> | null;
    headers?: unknown;
  } | undefined,
): boolean {
  if (!email || isImportedMessage(email)) return false;
  return authenticationResultsEvidence(email) === true;
}

/**
 * The From domain whose BIMI logo this message may show, or undefined. BIMI
 * needs a DMARC pass for the very domain in From: an aligned SPF or DKIM
 * pass without a DMARC verdict isn't enough, and neither is a pass that the
 * receiving server recorded for another header.from, or one in a header that
 * was not written on receipt (authenticationResultsUsable). Whether the
 * domain enforces DMARC and publishes a logo is /api/bimi's to find out.
 *
 * Mail a signed-in user handed in to the same server never gets a DMARC
 * verdict: Stalwart writes Authentication-Results only on what arrives from
 * outside. It does not compare the From header of a submission with the
 * user's addresses, so a user of the same server can write any From. A
 * message with no such header at all still counts when its From domain is
 * one of `internalDomains`, the organisation's own (lib/external-mail.ts
 * internalDomains, in ASCII form; a domain covers its subdomains). The same
 * domain's mail from outside carries the header and still needs the pass,
 * and so does one whose headers were all left out as not this server's
 * (authenticationResultsIgnored). A message from an imported file was not
 * handed in here and earns nothing.
 */
export function brandIndicatorDomain(
  email: {
    from?: { email?: string | null }[] | null;
    authenticationResults?: AuthenticationResults;
    authenticationResultsOnReceipt?: boolean;
    authenticationResultsIgnored?: boolean;
    keywords?: Record<string, boolean> | null;
    headers?: unknown;
  } | undefined,
  internalDomains: readonly string[] = [],
): string | undefined {
  const auth = email?.authenticationResults;
  const fromEmail = email?.from?.[0]?.email ?? undefined;
  if (!fromEmail) return undefined;
  const domain = domainOf(fromEmail);
  if (!domain) return undefined;
  if (isImportedMessage(email)) return undefined;
  if (!auth) {
    if (email?.authenticationResultsIgnored) return undefined;
    const ascii = toAsciiDomain(domain) ?? domain;
    return internalDomains.some((entry) => ascii === entry || ascii.endsWith(`.${entry}`)) ? domain : undefined;
  }
  if (!authenticationResultsUsable(email)) return undefined;
  if (auth.dmarc?.result !== 'pass' || isAuthenticationSpoofed(auth)) return undefined;
  const checked = auth.dmarc.domain ? domainOf(`@${auth.dmarc.domain}`) : domain;
  return checked === domain ? domain : undefined;
}

interface ResInfo {
  method: string;
  result: string;
  props: Record<string, string>;
}

/**
 * Split one Authentication-Results header into its `;`-separated parts
 * (RFC 8601), dropping comments. A `;` inside a quoted string or a comment
 * does not split: both can carry sender-chosen text such as the envelope
 * address.
 */
function splitResinfo(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === '\\' && (quoted || depth > 0)) {
      if (depth === 0) current += c + (header[i + 1] ?? '');
      i++;
      continue;
    }
    if (quoted) {
      current += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (depth > 0) {
      if (c === ')' && --depth === 0) current += ' ';
      continue;
    }
    if (c === '"') quoted = true;
    if (c === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const METHOD_RE = /^([a-z0-9][a-z0-9_-]*)(?:\/\d+)?\s*=\s*([a-z]+)(?=\s|$)/i;
const PROP_RE = /\s*([^\s=]+)\s*=\s*("(?:[^"\\]|\\.)*"|\S*)/y;

/**
 * Read one resinfo: the method must open the part, so a `dmarc=pass` that
 * appears inside a property value (say an envelope local part in
 * `smtp.mailfrom=`) is never taken for a result.
 */
function parseResinfo(part: string): ResInfo | null {
  const match = METHOD_RE.exec(part);
  if (!match) return null;
  const props: Record<string, string> = {};
  const rest = part.slice(match[0].length);
  PROP_RE.lastIndex = 0;
  let prop: RegExpExecArray | null;
  while ((prop = PROP_RE.exec(rest)) !== null && prop[0].length > 0) {
    const key = prop[1].toLowerCase();
    let value = prop[2];
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!(key in props)) props[key] = value;
  }
  return { method: match[1].toLowerCase(), result: match[2].toLowerCase(), props };
}

function parseResinfos(header: string): ResInfo[] {
  return splitResinfo(header)
    .map(parseResinfo)
    .filter((info): info is ResInfo => info !== null);
}

const DMARC_SEVERITY: Record<string, number> = {
  fail: 3,
  permerror: 2,
  temperror: 2,
  none: 1,
  pass: 0,
};

/**
 * Parse Authentication-Results headers into SPF, DKIM, DMARC results.
 *
 * Pass the headers in message order. The topmost one is the receiving
 * server's own; anything below it may have been written by the sender, so
 * DKIM, DMARC and iprev come from the topmost header only, and the others
 * can only escalate SPF to a failure, never supply a pass.
 */
function identityDomain(identity: string | undefined): string | undefined {
  const at = identity?.lastIndexOf('@') ?? -1;
  return identity && at >= 0 && at < identity.length - 1 ? identity.slice(at + 1) : undefined;
}

export function parseAuthenticationResults(headers: string | readonly string[]): AuthenticationResults {
  const results: AuthenticationResults = {};
  const list = typeof headers === 'string' ? [headers] : headers;
  const perHeader = list.map(parseResinfos);
  const own = perHeader[0] ?? [];
  const foreign = perHeader.slice(1).flat();

  type DkimResult = 'pass' | 'fail' | 'policy' | 'neutral' | 'temperror' | 'permerror';
  type DmarcResult = 'pass' | 'fail' | 'none';
  type DmarcPolicy = 'reject' | 'quarantine' | 'none';

  // Parse SPF. A single Authentication-Results header can carry more than one
  // SPF result when the server evaluates multiple identities (HELO and MAIL
  // FROM). Collect them all so a hard fail on any identity isn't softened to
  // an ambiguous state recorded for another one.
  const severity = (r: string) => SPF_SEVERITY[r as SpfResult] ?? -1;
  const isFailure = (r: string) => severity(r) >= SPF_SEVERITY.temperror;
  const toSpfEntry = (info: ResInfo): SpfEntry => {
    const identity = info.props['smtp.mailfrom'] !== undefined
      ? 'mailfrom'
      : info.props['smtp.helo'] !== undefined ? 'helo' : undefined;
    return {
      result: info.result as SpfResult,
      identity: identity as SpfEntry['identity'],
      domain: identity ? info.props[`smtp.${identity}`] || undefined : undefined,
    };
  };
  const spfResults: SpfEntry[] = [
    ...own.filter((info) => info.method === 'spf').map(toSpfEntry),
    ...foreign.filter((info) => info.method === 'spf').map(toSpfEntry).filter((e) => isFailure(e.result)),
  ];
  if (spfResults.length > 0) {
    // MAIL FROM is the primary SPF identity. Another identity (HELO) may only
    // escalate the headline to a genuine failure state — a HELO `none` or
    // `neutral` must not downgrade a MAIL FROM `pass`, since most senders
    // publish no SPF record for their EHLO hostname.
    let primary =
      spfResults.find((e) => e.identity === 'mailfrom') ?? spfResults[0];
    for (const cur of spfResults) {
      if (isFailure(cur.result) && severity(cur.result) > severity(primary.result)) {
        primary = cur;
      }
    }
    results.spf = {
      result: primary.result,
      domain: primary.domain,
      ...(spfResults.length > 1 ? { all: spfResults } : {}),
    };
  }

  // A message can carry several signatures (the author's domain and the
  // sending service's). The first one stays the headline; keep them all so
  // a pass further down still counts.
  const dkimResults = own
    .filter((info) => info.method === 'dkim')
    .map((info) => ({
      result: info.result as DkimResult,
      // Some receivers name the signature only by its identity (`header.i`,
      // `@domain` or `user@domain`, RFC 8601 2.7.1); its domain is the signer's.
      domain: info.props['header.d'] ?? identityDomain(info.props['header.i']),
      selector: info.props['header.s'],
    }));
  if (dkimResults.length > 0) {
    results.dkim = {
      ...dkimResults[0],
      ...(dkimResults.length > 1 ? { all: dkimResults } : {}),
    };
  }

  // One DMARC verdict per message; should a header carry several, the most
  // severe stands.
  const dmarc = own
    .filter((info) => info.method === 'dmarc')
    .reduce<ResInfo | undefined>(
      (worst, info) => (!worst || (DMARC_SEVERITY[info.result] ?? -1) > (DMARC_SEVERITY[worst.result] ?? -1) ? info : worst),
      undefined,
    );
  if (dmarc) {
    results.dmarc = {
      result: dmarc.result as DmarcResult,
      domain: dmarc.props['header.from'],
      policy: dmarc.props['policy.dmarc'] as DmarcPolicy | undefined,
    };
  }

  const iprev = own.find((info) => info.method === 'iprev');
  if (iprev) {
    results.iprev = {
      result: iprev.result as 'pass' | 'fail',
      ip: iprev.props['policy.iprev'],
    };
  }

  return results;
}

/**
 * Parse spam score from X-Spam-Result or X-Spam-Status headers
 */
export function parseSpamScore(header: string): { score: number; status: string } | null {
  // Try X-Spam-Status format: "No, score=-0.25"
  // And try X-Spam-Score format (Stalwart): "ham, score=-0.25"
  const statusMatch = header.match(/^(Yes|No|spam|ham),?\s+score=([-\d.]+)/i);
  if (statusMatch) {
    return {
      status: statusMatch[1].toLowerCase(),
      score: parseFloat(statusMatch[2])
    };
  }

  // Try to extract just the score
  const scoreMatch = header.match(/score[=:]?\s*([-\d.]+)/i);
  if (scoreMatch) {
    const score = parseFloat(scoreMatch[1]);
    return {
      score,
      status: score > 5 ? 'spam' : 'ham'
    };
  }

  return null;
}

/**
 * Parse Received headers to extract mail routing path
 */
interface ReceivedHeaderInfo {
  from: string;
  by: string;
  timestamp?: string;
  protocol?: string;
  id?: string;
}

export function parseReceivedHeaders(headers: string[]): ReceivedHeaderInfo[] {
  const path: ReceivedHeaderInfo[] = [];

  for (const header of headers) {
    const fromMatch = header.match(/from\s+([^\s]+)(?:\s+\([^)]+\))?/);
    const byMatch = header.match(/by\s+([^\s]+)/);
    const dateMatch = header.match(/;\s+(.+)$/);
    const protoMatch = header.match(/with\s+(\w+)/);
    const idMatch = header.match(/id\s+([^\s;]+)/);

    if (fromMatch || byMatch) {
      path.push({
        from: fromMatch?.[1] || 'unknown',
        by: byMatch?.[1] || 'unknown',
        timestamp: dateMatch?.[1],
        protocol: protoMatch?.[1],
        id: idMatch?.[1]
      });
    }
  }

  return path;
}

/**
 * Format bytes to human readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Get security status color and icon based on result
 */
export function getSecurityStatus(result?: string): {
  color: string;
  icon: 'check' | 'x' | 'alert' | 'minus';
  bgColor: string;
  borderColor: string;
} {
  switch (result) {
    case 'pass':
      return {
        color: 'text-green-700 dark:text-green-400',
        icon: 'check',
        bgColor: 'bg-gray-50 dark:bg-gray-800',
        borderColor: 'border-l-4 border-green-600 dark:border-green-500'
      };
    case 'fail':
    case 'permerror':
      return {
        color: 'text-red-700 dark:text-red-400',
        icon: 'x',
        bgColor: 'bg-gray-50 dark:bg-gray-800',
        borderColor: 'border-l-4 border-red-600 dark:border-red-500'
      };
    case 'softfail':
    case 'neutral':
    case 'temperror':
      return {
        color: 'text-warning',
        icon: 'alert',
        bgColor: 'bg-gray-50 dark:bg-gray-800',
        borderColor: 'border-l-4 border-warning'
      };
    default:
      return {
        color: 'text-gray-700 dark:text-gray-400',
        icon: 'minus',
        bgColor: 'bg-gray-50 dark:bg-gray-800',
        borderColor: 'border-l-4 border-gray-400 dark:border-gray-600'
      };
  }
}

/**
 * Parse X-Spam-LLM header to extract AI verdict and explanation
 */
export function parseSpamLLM(header: string): { verdict: string; explanation: string } | null {
  // Format: "LEGITIMATE (explanation)" or "SPAM (explanation)"
  // Trim the header first to remove any leading/trailing whitespace
  const trimmed = header.trim();
  const match = trimmed.match(/^(LEGITIMATE|SPAM|SUSPICIOUS)\s*\((.+)\)\s*$/i);

  if (match) {
    return {
      verdict: match[1].toUpperCase(),
      explanation: match[2].trim()
    };
  }
  return null;
}

/**
 * Extract list headers (List-Unsubscribe, List-Id, etc.)
 */
interface ListHeaders {
  listId?: string;
  listUnsubscribe?: {
    http?: string;
    mailto?: string;
    preferred?: 'http' | 'mailto';
  };
  listHelp?: string;
  listPost?: string;
}

export function extractListHeaders(headers: Record<string, string | string[]>): ListHeaders {
  const result: ListHeaders = {};

  if (headers['List-Id']) {
    result.listId = Array.isArray(headers['List-Id'])
      ? headers['List-Id'][0]
      : headers['List-Id'];
  }

  if (headers['List-Unsubscribe']) {
    const unsub = Array.isArray(headers['List-Unsubscribe'])
      ? headers['List-Unsubscribe'][0]
      : headers['List-Unsubscribe'];

    const parsed = parseUnsubscribeUrls(unsub);
    if (parsed.preferred) {
      result.listUnsubscribe = parsed;
    }
  }

  if (headers['List-Help']) {
    result.listHelp = Array.isArray(headers['List-Help'])
      ? headers['List-Help'][0]
      : headers['List-Help'];
  }

  if (headers['List-Post']) {
    result.listPost = Array.isArray(headers['List-Post'])
      ? headers['List-Post'][0]
      : headers['List-Post'];
  }

  return result;
}