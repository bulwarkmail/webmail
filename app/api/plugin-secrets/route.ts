import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { CREDENTIAL_ID_RE, checkInject, credentialOrigin } from '@/lib/plugin-secrets/credentials';
import { adminCredentialOrigins, adminCredentialStatus } from '@/lib/plugin-secrets/proxy';
import { declaredUserCredential } from '@/lib/plugin-secrets/known-plugins';
import {
  VaultFullError,
  deleteUserCredentials,
  listUserCredentials,
  putUserCredential,
  type VaultUser,
} from '@/lib/plugin-secrets/vault';

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const MAX_SECRET_LENGTH = 4096;
const NO_STORE = { 'cache-control': 'no-store' };

async function currentUser(request: NextRequest): Promise<VaultUser | NextResponse> {
  await configManager.ensureLoaded();
  if (!configManager.getPolicy().features.pluginsEnabled) {
    return NextResponse.json({ error: 'Plugins are turned off' }, { status: 403 });
  }
  const creds = await getStalwartCredentials(request);
  if (!creds) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  return { username: creds.accountName, serverUrl: creds.serverUrl };
}

/** GET /api/plugin-secrets[?plugin=<id>] - the user's connected accounts, without secrets. */
export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (user instanceof NextResponse) return user;
  const pluginId = request.nextUrl.searchParams.get('plugin') ?? undefined;
  if (pluginId !== undefined && !PLUGIN_ID_RE.test(pluginId)) {
    return NextResponse.json({ error: 'Invalid plugin id' }, { status: 400 });
  }
  const credentials = await listUserCredentials(user, pluginId);
  // For one plugin, also say which of its admin credentials are set up, and
  // on which servers: the host page checks the links a plugin shows against
  // them (the plugin itself only gets yes/no, see proxyAccounts).
  const [admin, adminOrigins] = pluginId
    ? await Promise.all([adminCredentialStatus(pluginId), adminCredentialOrigins(pluginId)])
    : [[], []];
  return NextResponse.json({ credentials, admin, adminOrigins }, { headers: NO_STORE });
}

/**
 * POST /api/plugin-secrets - connect an account for a plugin.
 * Body: { pluginId, credentialId, label, origin, inject, username?, secret? }
 *
 * Sent by the host's own "Connect" dialog, where the user typed the secret
 * and saw which plugin and which server it is for. Without `secret` it only
 * records the approved server, for a sign-in flow that fills the secret in
 * later through the proxy.
 */
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const user = await currentUser(request);
  if (user instanceof NextResponse) return user;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { pluginId, credentialId, label, username, secret } = body;
  const origin = credentialOrigin(body.origin);
  const inject = checkInject(body.inject);
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) return bad('Invalid plugin id');
  if (typeof credentialId !== 'string' || !CREDENTIAL_ID_RE.test(credentialId)) return bad('Invalid credential id');
  if (typeof label !== 'string' || !label.trim() || label.length > 80) return bad('Invalid label');
  if (!origin) return bad('The server address must start with https://');
  if (!inject) return bad('Invalid inject');
  if (username !== undefined && (typeof username !== 'string' || username.length > 256 || /[\r\n]/.test(username))) return bad('Invalid username');
  if (secret !== undefined && (typeof secret !== 'string' || !secret || secret.length > MAX_SECRET_LENGTH || /[\r\n]/.test(secret))) return bad('Invalid secret');

  // A credential belongs to a plugin this server knows declares it: without
  // that, any signed-in user could park a secret under a made-up plugin id
  // and use the proxy as a relay to any server. The manifest's own inject
  // and, when fixed, its origin are what count, not what the browser sent.
  const spec = await declaredUserCredential(pluginId, credentialId);
  if (!spec) return NextResponse.json({ error: 'No such plugin credential' }, { status: 404 });
  if (spec.origin && credentialOrigin(spec.origin) !== origin) return bad('This credential is only for the server its plugin names');

  try {
    await putUserCredential(user, pluginId, credentialId, {
      origin, inject: spec.inject, label: label.trim(),
      ...(typeof username === 'string' && username ? { username } : {}),
      ...(typeof secret === 'string' ? { secret } : {}),
    });
  } catch (error) {
    if (error instanceof VaultFullError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

/** DELETE /api/plugin-secrets?plugin=<id>[&credential=<id>] - disconnect. */
export async function DELETE(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const user = await currentUser(request);
  if (user instanceof NextResponse) return user;
  const pluginId = request.nextUrl.searchParams.get('plugin') ?? '';
  const credentialId = request.nextUrl.searchParams.get('credential') ?? undefined;
  if (!PLUGIN_ID_RE.test(pluginId)) return bad('Invalid plugin id');
  if (credentialId !== undefined && !CREDENTIAL_ID_RE.test(credentialId)) return bad('Invalid credential id');
  await deleteUserCredentials(user, pluginId, credentialId);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
