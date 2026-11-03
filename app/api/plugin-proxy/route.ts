import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { isNoThirdPartyTrafficOn, thirdPartyRefusal } from '@/lib/admin/third-party-mode';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { CREDENTIAL_ID_RE, type CredentialSpec } from '@/lib/plugin-secrets/credentials';
import { credentialAllowedInMode } from '@/lib/outgoing-hosts';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { ProxyError, adminEnteredOrigin, proxyRequest, type CaptureSpec } from '@/lib/plugin-secrets/proxy';
import { getPluginConfig } from '@/lib/admin/plugin-config';
import { bootGateResponse } from '@/lib/shared-store/boot-gate';

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function parseCapture(raw: string | null): CaptureSpec | null | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.secret !== 'string' || !FIELD_RE.test(v.secret)) return null;
    if (v.username !== undefined && (typeof v.username !== 'string' || !FIELD_RE.test(v.username))) return null;
    return { secret: v.secret, ...(typeof v.username === 'string' ? { username: v.username } : {}) };
  } catch {
    return null;
  }
}

/**
 * POST /api/plugin-proxy?plugin=<id>&credential=<id>&url=<target>
 *
 * Forwards a plugin's request to `url` with the named credential added. The
 * target method goes in `X-Bulwark-Method` (default GET); the request body
 * and headers are passed through, minus cookies, auth and transport headers.
 * `X-Bulwark-Capture: {"secret":"appPassword","username":"loginName"}` stores
 * those JSON fields of the response as the credential instead of returning
 * them (Nextcloud Login Flow v2).
 *
 * Called by the host page on a plugin's behalf, never by the sandboxed
 * plugin itself (its iframe has an opaque origin and is refused here).
 */
export async function POST(request: NextRequest) {
  // The proxy doesn't run for this route, so it applies the boot gate itself.
  const notReady = bootGateResponse();
  if (notReady) return notReady;
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;

  await configManager.ensureLoaded();
  if (!configManager.getPolicy().features.pluginsEnabled) {
    return NextResponse.json({ error: 'Plugins are turned off', code: 'disabled' }, { status: 403 });
  }
  const thirdPartyOff = await isNoThirdPartyTrafficOn();

  const creds = await getStalwartCredentials(request);
  if (!creds) return NextResponse.json({ error: 'Not authenticated', code: 'unauthenticated' }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const pluginId = params.get('plugin') ?? '';
  const credentialId = params.get('credential') ?? '';
  const url = params.get('url') ?? '';
  if (!PLUGIN_ID_RE.test(pluginId) || !CREDENTIAL_ID_RE.test(credentialId) || !url) {
    return NextResponse.json({ error: 'plugin, credential and url are required', code: 'bad_request' }, { status: 400 });
  }
  // With third-party traffic off only a server the admin typed on the
  // plugin's admin page stays reachable (a company link check); servers
  // fixed in a manifest or brought as a field's default, and accounts users
  // connect, are outside hosts (#903).
  if (thirdPartyOff) {
    const plugin = await getPlugin(pluginId);
    const spec = (plugin as { credentials?: Record<string, CredentialSpec> } | null)?.credentials?.[credentialId];
    if (!credentialAllowedInMode(spec) || !adminEnteredOrigin(spec, await getPluginConfig(pluginId), plugin?.configSchema)) {
      // Marked as the proxy's own refusal, like its other errors, so a
      // plugin can tell it from the service answering 403.
      const refused = thirdPartyRefusal('The plugin proxy');
      refused.headers.set('x-bulwark-proxy-error', 'no-third-party-traffic');
      return refused;
    }
  }
  const capture = parseCapture(request.headers.get('x-bulwark-capture'));
  if (capture === null) {
    return NextResponse.json({ error: 'Invalid X-Bulwark-Capture header', code: 'bad_capture' }, { status: 400 });
  }

  try {
    return await proxyRequest({
      user: { username: creds.accountName, serverUrl: creds.serverUrl },
      pluginId,
      credentialId,
      url,
      method: request.headers.get('x-bulwark-method') ?? 'GET',
      headers: request.headers,
      body: request.body,
      capture,
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof ProxyError) {
      // Marks the proxy's own refusals, so the plugin can tell them from the
      // upstream server's errors.
      const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-bulwark-proxy-error': error.code };
      const retryAfter = (error as ProxyError & { retryAfter?: number }).retryAfter;
      if (retryAfter) headers['retry-after'] = String(retryAfter);
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
    }
    return NextResponse.json({ error: 'Internal server error', code: 'internal' }, { status: 500 });
  }
}
