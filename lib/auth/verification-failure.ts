import { logger } from '@/lib/logger';
import { JmapAuthVerificationError, upstreamFailureHint } from '@/lib/auth/verify-jmap-auth';
import { getCookieOptions } from '@/lib/oauth/cookie-config';

export interface VerificationFailureBody {
  error: string;
  code?: string;
  hint?: string;
}

/**
 * Log a failed upstream check in a cookie-minting route and build its reply.
 *
 * When this process cannot reach or trust the mail server (self-signed
 * certificate, split DNS) while the browser can, sign-in itself works but no
 * context cookie is minted, and every cookie-gated route (/api/fetch-ical,
 * settings sync, ...) answers 401 with nothing in any log (#1073).
 *
 * The network code and hint go back to the browser only for admin-configured
 * servers: for a user-supplied URL they would turn the route into a probe of
 * which hosts and ports answer.
 */
export function verificationFailureBody(
  route: string,
  error: JmapAuthVerificationError,
  serverUrl: string,
  trusted: boolean,
): VerificationFailureBody {
  const hint = upstreamFailureHint(error.code);
  const fields = {
    serverUrl,
    status: error.status,
    upstreamStatus: error.upstreamStatus,
    code: error.code,
    hint,
  };
  if (error.status >= 500) {
    logger.warn(`${route}: could not verify the sign-in with the mail server: ${error.message}`, fields);
  } else {
    logger.debug(`${route}: sign-in verification refused: ${error.message}`, fields);
  }

  if (!trusted || !error.code) return { error: error.message };
  return hint ? { error: error.message, code: error.code, hint } : { error: error.message, code: error.code };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '[::1]'
    || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Browsers drop `Secure` cookies set by a plain-http page (loopback aside),
 * which leaves every cookie-gated route answering 401 just like a failed mint
 * (#1073). Returns a hint when this request came from such a page.
 */
export function insecureCookieHint(request: Request): string | undefined {
  if (!getCookieOptions().secure) return undefined;
  const origin = request.headers.get('origin');
  if (!origin) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || isLoopbackHost(url.hostname)) return undefined;
  return 'This page was loaded over plain http, so the browser drops the Secure sign-in cookies. '
    + 'Serve the webmail over HTTPS, or set COOKIE_SECURE=false.';
}
