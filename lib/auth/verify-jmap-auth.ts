import { isPublicHttpUrl } from '@/lib/security/url-guard';

const VERIFY_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

export class JmapAuthVerificationError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'JmapAuthVerificationError';
    this.status = status;
  }
}

function isSupportedProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

export function normalizeJmapServerUrl(serverUrl: string): string {
  // App-relative URLs (the dev mock JMAP server, e.g. /api/dev-jmap) have no
  // host or protocol to validate; they can only ever target this app itself.
  // Protocol-relative URLs (//host/...) are NOT app-relative and fall through
  // to the absolute-URL parse below, which rejects them.
  if (serverUrl.startsWith('/') && !serverUrl.startsWith('//')) {
    const url = new URL(serverUrl, 'http://relative.invalid');
    return url.pathname.replace(/\/+$/, '');
  }

  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new JmapAuthVerificationError('Invalid server URL', 400);
  }

  if (!isSupportedProtocol(url.protocol)) {
    throw new JmapAuthVerificationError('Unsupported server URL protocol', 400);
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

export function validateProxyAuthHeader(authHeader: string): void {
  if (!/^(?:Basic|Bearer)\s+\S+$/i.test(authHeader)) {
    throw new JmapAuthVerificationError('Invalid Authorization header', 400);
  }
}

/**
 * For a `Basic` Authorization header, assert that the user portion of the
 * credentials matches `claimedUsername`. Prevents callers of routes that
 * accept independent `username` + `authHeader` fields from binding a cookie
 * to one identity while authenticating as another. No-op for Bearer.
 */
export function assertBasicAuthMatchesUsername(authHeader: string, claimedUsername: string): void {
  const match = /^Basic\s+(\S+)$/i.exec(authHeader);
  if (!match) return;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    throw new JmapAuthVerificationError('Invalid Authorization header', 400);
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) {
    throw new JmapAuthVerificationError('Invalid Authorization header', 400);
  }
  const credUser = decoded.slice(0, colon);
  if (credUser !== claimedUsername) {
    throw new JmapAuthVerificationError('Username does not match credentials', 400);
  }
}

export async function verifyJmapAuth(
  serverUrl: string,
  authHeader: string,
  options: { trusted?: boolean } = {},
): Promise<string> {
  const normalizedServerUrl = normalizeJmapServerUrl(serverUrl);
  validateProxyAuthHeader(authHeader);

  if (!options.trusted && !(await isPublicHttpUrl(normalizedServerUrl))) {
    throw new JmapAuthVerificationError('Server URL is not allowed', 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    let currentUrl = `${normalizedServerUrl}/.well-known/jmap`;
    let response: Response | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (!options.trusted && !(await isPublicHttpUrl(currentUrl))) {
        throw new JmapAuthVerificationError('Server URL is not allowed', 400);
      }

      response = await fetch(currentUrl, {
        method: 'GET',
        headers: { Authorization: authHeader },
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new JmapAuthVerificationError('Failed to verify JMAP session', 502);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response) {
      throw new JmapAuthVerificationError('Failed to verify JMAP session', 502);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new JmapAuthVerificationError('Too many redirects verifying JMAP session', 502);
    }

    if (!response.ok) {
      throw new JmapAuthVerificationError(
        response.status === 401 || response.status === 403
          ? 'Authentication failed'
          : 'Failed to verify JMAP session',
        response.status === 401 || response.status === 403 ? 401 : 502,
      );
    }

    const session = await response.json().catch(() => null) as { apiUrl?: unknown; accounts?: unknown } | null;
    if (!session || typeof session.apiUrl !== 'string' || typeof session.accounts !== 'object' || session.accounts === null) {
      throw new JmapAuthVerificationError('Invalid JMAP session response', 502);
    }

    return normalizedServerUrl;
  } catch (error) {
    if (error instanceof JmapAuthVerificationError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new JmapAuthVerificationError('JMAP session verification timed out', 504);
    }
    throw new JmapAuthVerificationError('Failed to verify JMAP session', 502);
  } finally {
    clearTimeout(timeout);
  }
}
