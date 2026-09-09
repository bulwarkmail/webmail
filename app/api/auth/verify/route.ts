import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { JmapAuthVerificationError, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { configManager } from '@/lib/admin/config-manager';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';

/**
 * Server-side Basic-auth pre-check for the login form (#969).
 *
 * When the browser itself probes the JMAP session URL with wrong credentials,
 * the server answers 401 + `WWW-Authenticate: Basic`, and on a same-origin
 * deployment (JMAP reverse-proxied under the webmail's own host) the browser
 * pops its native "This site requires authentication" dialog before the
 * login form can show its own error. Probing from here first means a wrong
 * password never reaches the browser as a 401 with a Basic challenge: the
 * answer comes back as JSON from our own origin.
 *
 * The result is only *authoritative* for a definitive upstream 401. Anything
 * else - the JMAP server unreachable from this container, a timeout, 5xx, a
 * TOTP challenge (402), an unconfigured or disallowed URL - is reported as
 * `inconclusive` so the browser-side connect keeps handling it exactly as
 * before. Some deployments can't resolve the JMAP host from inside the
 * container at all; those must keep logging in.
 */
export type VerifyResult = 'ok' | 'unauthorized' | 'inconclusive';

function respond(result: VerifyResult) {
  return NextResponse.json({ result }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const serverUrl = body?.serverUrl;
    const username = body?.username;
    const password = body?.password;
    if (typeof serverUrl !== 'string' || typeof username !== 'string' || typeof password !== 'string'
      || !serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    await configManager.ensureLoaded();
    const oauthEnabled = configManager.get<boolean>('oauthEnabled', false);
    const oauthOnly = configManager.get<boolean>('oauthOnly', false);
    if (oauthEnabled && oauthOnly) {
      return respond('inconclusive');
    }

    // Same upstream pinning as /api/auth/session: an unauthenticated caller
    // must not be able to point this route at arbitrary internal hosts.
    const configuredServerUrl =
      configManager.get<string>('jmapServerUrl', '') ||
      process.env.JMAP_SERVER_URL ||
      process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
      '';
    const allowCustomEndpoint = configManager.get<boolean>('allowCustomJmapEndpoint', false);
    const serverList = parseJmapServers(configManager.get<unknown>('jmapServers', []));
    const trustedUrl = resolveTrustedJmapUrl(serverUrl, configuredServerUrl, serverList);

    let upstreamUrl: string;
    let upstreamTrusted: boolean;
    if (trustedUrl) {
      upstreamUrl = trustedUrl;
      upstreamTrusted = true;
    } else if (allowCustomEndpoint && (await isPublicHttpUrl(serverUrl))) {
      upstreamUrl = serverUrl;
      upstreamTrusted = false;
    } else {
      return respond('inconclusive');
    }

    const authHeader = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    try {
      await verifyJmapAuth(upstreamUrl, authHeader, { trusted: upstreamTrusted });
      return respond('ok');
    } catch (error) {
      if (error instanceof JmapAuthVerificationError && error.upstreamStatus === 401) {
        return respond('unauthorized');
      }
      logger.debug('Login pre-check inconclusive', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return respond('inconclusive');
    }
  } catch (error) {
    logger.error('Login pre-check error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return respond('inconclusive');
  }
}
