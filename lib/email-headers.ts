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

/**
 * Parse Authentication-Results header to extract SPF, DKIM, DMARC results
 */
export function parseAuthenticationResults(header: string): AuthenticationResults {
  const results: AuthenticationResults = {};

  type DkimResult = 'pass' | 'fail' | 'policy' | 'neutral' | 'temperror' | 'permerror';
  type DmarcResult = 'pass' | 'fail' | 'none';
  type DmarcPolicy = 'reject' | 'quarantine' | 'none';

  // Parse SPF. A single Authentication-Results header can carry more than one
  // SPF result when the server evaluates multiple identities (HELO and MAIL
  // FROM). Collect them all and surface the most severe as the headline so a
  // hard MAIL FROM `fail` isn't softened to a HELO `temperror`.
  const spfRegex = /spf=(\w+)(?:\s+\([^)]*\))?(?:\s+smtp\.(mailfrom|helo)=([^\s;]+))?/g;
  const spfResults: SpfEntry[] = [];
  let spfM: RegExpExecArray | null;
  while ((spfM = spfRegex.exec(header)) !== null) {
    spfResults.push({
      result: spfM[1] as SpfResult,
      identity: spfM[2] as SpfEntry['identity'],
      domain: spfM[3],
    });
  }
  if (spfResults.length > 0) {
    const severity = (r: string) => SPF_SEVERITY[r as SpfResult] ?? -1;
    // Most severe wins; on a tie prefer the MAIL FROM identity (more meaningful
    // than HELO) and otherwise keep the first occurrence.
    const primary = spfResults.reduce((best, cur) => {
      if (severity(cur.result) > severity(best.result)) return cur;
      if (
        severity(cur.result) === severity(best.result) &&
        best.identity !== 'mailfrom' &&
        cur.identity === 'mailfrom'
      ) return cur;
      return best;
    });
    results.spf = {
      result: primary.result,
      domain: primary.domain,
      ...(spfResults.length > 1 ? { all: spfResults } : {}),
    };
  }

  // Parse DKIM
  const dkimMatch = header.match(/dkim=(\w+)(?:\s+header\.d=([^\s]+))?(?:\s+header\.s=([^\s]+))?/);
  if (dkimMatch) {
    results.dkim = {
      result: dkimMatch[1] as DkimResult,
      domain: dkimMatch[2],
      selector: dkimMatch[3]
    };
  }

  // Parse DMARC
  const dmarcMatch = header.match(/dmarc=(\w+)(?:\s+header\.from=([^\s]+))?(?:\s+policy\.dmarc=(\w+))?/);
  if (dmarcMatch) {
    results.dmarc = {
      result: dmarcMatch[1] as DmarcResult,
      domain: dmarcMatch[2],
      policy: dmarcMatch[3] as DmarcPolicy | undefined
    };
  }

  // Parse IP reverse lookup
  const iprevMatch = header.match(/iprev=(\w+)(?:\s+policy\.iprev=([\d.]+))?/);
  if (iprevMatch) {
    results.iprev = {
      result: iprevMatch[1] as 'pass' | 'fail',
      ip: iprevMatch[2]
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