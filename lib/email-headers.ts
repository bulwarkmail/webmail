import { AuthenticationResults } from './jmap/types';
import { parseUnsubscribeUrls } from './validation';

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
  if (auth.spf?.result === 'fail' && auth.dkim?.result !== 'pass') return true;
  return false;
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

  const dkim = own.find((info) => info.method === 'dkim');
  if (dkim) {
    results.dkim = {
      result: dkim.result as DkimResult,
      domain: dkim.props['header.d'],
      selector: dkim.props['header.s'],
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