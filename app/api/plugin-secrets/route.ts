import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { IMPERSONATION_GRANT_COOKIE, openImpersonationGrant } from '@/lib/impersonation/grant-cookie';
import { logger } from '@/lib/logger';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials, type StalwartCredentials } from '@/lib/stalwart/credentials';
import { CREDENTIAL_ID_RE, checkInject, credentialOrigin } from '@/lib/plugin-secrets/credentials';
import { appPasswordDescription } from '@/lib/plugin-secrets/app-password-permissions';
import { makePluginAppPassword, revokePluginAppPassword } from '@/lib/plugin-secrets/app-password';
import { adminCredentialOrigins, adminCredentialStatus } from '@/lib/plugin-secrets/proxy';
import { declaringPlugin } from '@/lib/plugin-secrets/known-plugins';
import {
  VaultFullError,
  deleteAllUserCredentials,
  deleteUserCredentials,
  getUserCredential,
  listUserCredentials,
  putUserCredential,
  type VaultUser,
} from '@/lib/plugin-secrets/vault';
import { storedDataUnavailableResponse } from '@/lib/stored-data-errors';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { clearWipeProof, hasWipeProof, setWipeProof } from '@/lib/plugin-secrets/wipe-proof';

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const MAX_SECRET_LENGTH = 4096;
const NO_STORE = { 'cache-control': 'no-store' };

interface CurrentUser {
  user: VaultUser;
  creds: StalwartCredentials;
}

async function currentUser(request: NextRequest): Promise<CurrentUser | NextResponse> {
  await configManager.ensureLoaded();
  if (!configManager.getPolicy().features.pluginsEnabled) {
    return NextResponse.json({ error: 'Plugins are turned off' }, { status: 403 });
  }
  const creds = await getStalwartCredentials(request);
  if (!creds) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  return { user: { username: creds.accountName, serverUrl: creds.serverUrl }, creds };
}

function appPasswordsOn(): boolean {
  return configManager.get<boolean>('stalwartFeaturesEnabled', true);
}

/** GET /api/plugin-secrets[?plugin=<id>] - the user's connected accounts, without secrets. */
export async function GET(request: NextRequest) {
  const current = await currentUser(request);
  if (current instanceof NextResponse) return current;
  const { user } = current;
  const pluginId = request.nextUrl.searchParams.get('plugin') ?? undefined;
  if (pluginId !== undefined && !PLUGIN_ID_RE.test(pluginId)) {
    return NextResponse.json({ error: 'Invalid plugin id' }, { status: 400 });
  }
  let credentials;
  try {
    credentials = await listUserCredentials(user, pluginId);
  } catch (error) {
    const unavailable = storedDataUnavailableResponse(error, NO_STORE);
    if (unavailable) return unavailable;
    throw error;
  }
  // For one plugin, also say which of its admin credentials are set up, and
  // on which servers: the host page checks the links a plugin shows against
  // them (the plugin itself only gets yes/no, see proxyAccounts).
  const [admin, adminOrigins] = pluginId
    ? await Promise.all([adminCredentialStatus(pluginId), adminCredentialOrigins(pluginId)])
    : [[], []];
  const answer = NextResponse.json({ credentials, admin, adminOrigins }, { headers: NO_STORE });
  if (IS_DESKTOP_BUILD && credentials.length > 0) setWipeProof(answer, user);
  return answer;
}

/**
 * POST /api/plugin-secrets - connect an account for a plugin.
 * Body: { pluginId, credentialId, label, origin, inject, username?, secret? }
 *
 * Sent by the host's own "Connect" dialog, where the user typed the secret
 * and saw which plugin and which server it is for. Without `secret` it only
 * records the approved server, for a sign-in flow that fills the secret in
 * later through the proxy.
 *
 * Body: { pluginId, credentialId, label, appPassword: true } for a credential
 * whose manifest says `appPassword`: the server makes the secret itself, with
 * only the permissions that manifest lists.
 */
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const current = await currentUser(request);
  if (current instanceof NextResponse) return current;
  const { user } = current;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { pluginId, credentialId, label, username, secret } = body;
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) return bad('Invalid plugin id');
  if (typeof credentialId !== 'string' || !CREDENTIAL_ID_RE.test(credentialId)) return bad('Invalid credential id');
  if (typeof label !== 'string' || !label.trim() || label.length > 80) return bad('Invalid label');
  if (body.appPassword !== undefined) {
    if (body.appPassword !== true || username !== undefined || secret !== undefined || body.origin !== undefined) {
      return bad('An app password comes with nothing else');
    }
    return connectAppPassword(current, pluginId, credentialId, label.trim());
  }
  const origin = credentialOrigin(body.origin);
  const inject = checkInject(body.inject);
  if (!origin) return bad('The server address must start with https://');
  if (!inject) return bad('Invalid inject');
  if (username !== undefined && (typeof username !== 'string' || username.length > 256 || /[\r\n]/.test(username))) return bad('Invalid username');
  if (secret !== undefined && (typeof secret !== 'string' || !secret || secret.length > MAX_SECRET_LENGTH || /[\r\n]/.test(secret))) return bad('Invalid secret');

  // A credential belongs to a plugin this server knows declares it: without
  // that, any signed-in user could park a secret under a made-up plugin id
  // and use the proxy as a relay to any server. The manifest's own inject
  // and, when fixed, its origin are what count, not what the browser sent.
  const spec = (await declaringPlugin(pluginId, credentialId))?.spec;
  if (!spec) return NextResponse.json({ error: 'No such plugin credential' }, { status: 404 });
  if (spec.appPassword) return bad('The server makes this credential\'s app password');
  if (spec.origin && credentialOrigin(spec.origin) !== origin) return bad('This credential is only for the server its plugin names');

  try {
    await putUserCredential(user, pluginId, credentialId, {
      origin, inject: spec.inject, label: label.trim(),
      ...(typeof username === 'string' && username ? { username } : {}),
      ...(typeof secret === 'string' ? { secret } : {}),
    });
  } catch (error) {
    if (error instanceof VaultFullError) return NextResponse.json({ error: error.message }, { status: 409 });
    const unavailable = storedDataUnavailableResponse(error, NO_STORE);
    if (unavailable) return unavailable;
    throw error;
  }
  const answer = NextResponse.json({ ok: true }, { headers: NO_STORE });
  if (IS_DESKTOP_BUILD) setWipeProof(answer, user);
  return answer;
}

/**
 * Make an app password on the mail server the user is signed in to, with
 * their own session, and store it for the plugin. The secret never reaches
 * the browser. Connecting again replaces the app password made before.
 */
async function connectAppPassword(current: CurrentUser, pluginId: string, credentialId: string, label: string) {
  const { user, creds } = current;
  const plugin = await declaringPlugin(pluginId, credentialId);
  if (!plugin) return NextResponse.json({ error: 'No such plugin credential' }, { status: 404 });
  const { spec } = plugin;
  if (!spec.appPassword) return bad('This credential takes a password the user enters');
  // A manifest stored before app passwords took a permission list has none:
  // never make one with the account's full rights.
  if (!Array.isArray(spec.appPassword.permissions) || spec.appPassword.permissions.length === 0) {
    return bad('The plugin lists no permissions for its app password');
  }
  if (!appPasswordsOn()) return NextResponse.json({ error: 'App passwords are not available on this server' }, { status: 403 });
  // A support session opens the mailbox with a short-lived app password; it
  // must not leave a lasting one behind.
  if (creds.slot === 0 && openImpersonationGrant((await cookies()).get(IMPERSONATION_GRANT_COOKIE)?.value)) {
    return NextResponse.json({ error: 'Not in a support session' }, { status: 403 });
  }
  const origin = credentialOrigin(creds.serverUrl);
  if (!origin) return bad('The mail server must be reached over https');
  if (spec.origin && credentialOrigin(spec.origin) !== origin) return bad('This credential is only for the server its plugin names');

  let before;
  try {
    before = await getUserCredential(user, pluginId, credentialId);
  } catch (error) {
    const unavailable = storedDataUnavailableResponse(error, NO_STORE);
    if (unavailable) return unavailable;
    throw error;
  }
  let made: { id: string; secret: string; username: string };
  try {
    made = await makePluginAppPassword(creds, appPasswordDescription(plugin.name), spec.appPassword.permissions);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Plugin app password was not created', { error: message });
    return NextResponse.json({ error: `The mail server made no app password: ${message}` }, { status: 502 });
  }
  try {
    await putUserCredential(user, pluginId, credentialId, {
      origin, inject: spec.inject, label, username: made.username, secret: made.secret, appPasswordId: made.id,
    });
  } catch (error) {
    await revokePluginAppPassword(creds, made.id);
    if (error instanceof VaultFullError) return NextResponse.json({ error: error.message }, { status: 409 });
    const unavailable = storedDataUnavailableResponse(error, NO_STORE);
    if (unavailable) return unavailable;
    throw error;
  }
  // So connecting again (a lost vault, a password the user deleted) leaves
  // no unused app passwords in the user's list.
  if (before?.appPasswordId && before.origin === origin) await revokePluginAppPassword(creds, before.appPasswordId);
  const answer = NextResponse.json({ ok: true }, { headers: NO_STORE });
  if (IS_DESKTOP_BUILD) setWipeProof(answer, user);
  return answer;
}

/** DELETE /api/plugin-secrets?plugin=<id>[&credential=<id>] - disconnect. */
export async function DELETE(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  // An account dropped earlier, in the desktop app: no session cookie left, so it
  // takes the proof that account got while it had one (lib/plugin-secrets/wipe-proof.ts).
  const { searchParams } = request.nextUrl;
  const owner = searchParams.get('username');
  const server = searchParams.get('server');
  if (IS_DESKTOP_BUILD && searchParams.get('all') === 'true' && owner && server) {
    const named = { username: owner, serverUrl: server };
    if (!hasWipeProof(request, named)) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: NO_STORE });
    try {
      await deleteAllUserCredentials(named);
      const answer = NextResponse.json({ ok: true }, { headers: NO_STORE });
      clearWipeProof(answer, named);
      return answer;
    } catch (error) {
      const unavailable = storedDataUnavailableResponse(error, NO_STORE);
      if (unavailable) return unavailable;
      throw error;
    }
  }
  const current = await currentUser(request);
  if (current instanceof NextResponse) return current;
  const { user, creds } = current;
  // A wipe in the desktop app, where this server and its files are on the device.
  // On an instance they aren't the device's to remove.
  if (IS_DESKTOP_BUILD && request.nextUrl.searchParams.get('all') === 'true') {
    try {
      await deleteAllUserCredentials(user);
      const answer = NextResponse.json({ ok: true }, { headers: NO_STORE });
      clearWipeProof(answer, user);
      return answer;
    } catch (error) {
      const unavailable = storedDataUnavailableResponse(error, NO_STORE);
      if (unavailable) return unavailable;
      throw error;
    }
  }
  const pluginId = request.nextUrl.searchParams.get('plugin') ?? '';
  const credentialId = request.nextUrl.searchParams.get('credential') ?? undefined;
  if (!PLUGIN_ID_RE.test(pluginId)) return bad('Invalid plugin id');
  if (credentialId !== undefined && !CREDENTIAL_ID_RE.test(credentialId)) return bad('Invalid credential id');
  let removed;
  try {
    removed = await deleteUserCredentials(user, pluginId, credentialId);
  } catch (error) {
    const unavailable = storedDataUnavailableResponse(error, NO_STORE);
    if (unavailable) return unavailable;
    throw error;
  }
  // The app passwords the server made for them go too, on the server they
  // were made on.
  const origin = credentialOrigin(creds.serverUrl);
  for (const credential of removed) {
    if (credential.appPasswordId && credential.origin === origin && appPasswordsOn()) {
      await revokePluginAppPassword(creds, credential.appPasswordId);
    }
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
