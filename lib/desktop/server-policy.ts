/**
 * What OS policies say the embedded server has to enforce: which plugins may be
 * installed, switched on or served, and which mail servers it may sign in to.
 *
 * The Electron main process sends this at start and on every change. It lives on
 * globalThis, which all of Next's bundles share, like the list of trusted servers
 * in trusted-servers.ts. Nothing in the renderer or the environment can write it.
 *
 * Only the desktop build has it. In every other build these all answer "allowed".
 */

import { NextResponse } from 'next/server';
import { IS_DESKTOP_BUILD } from './flag';
import { jmapServerAllowed, pluginAllowedByPolicy, type ServerPolicy } from './policy-schema';

const POLICY_KEY = Symbol.for('bulwark.desktop.serverPolicy');

function serverPolicy(): ServerPolicy | undefined {
  if (!IS_DESKTOP_BUILD) return undefined;
  return (globalThis as unknown as Record<symbol, ServerPolicy | undefined>)[POLICY_KEY];
}

export function pluginRefusedByDevicePolicy(id: unknown): boolean {
  const policy = serverPolicy();
  return !!policy && !pluginAllowedByPolicy(policy.pluginsMode, policy.pluginAllowlist, id);
}

/** A 403 with a code the install route's caller can show, or null when it's allowed. */
export function devicePolicyPluginRefusal(id: unknown): NextResponse | null {
  if (!pluginRefusedByDevicePolicy(id)) return null;
  return NextResponse.json({ error: 'Your organisation does not allow this plugin on this device', code: 'blocked_by_policy' }, { status: 403 });
}

export function mailServerRefusedByDevicePolicy(serverUrl: unknown): boolean {
  const policy = serverPolicy();
  return !!policy && !jmapServerAllowed(policy.allowedJmapServers, serverUrl);
}

export function devicePolicyServerRefusal(serverUrl: unknown): NextResponse | null {
  if (!mailServerRefusedByDevicePolicy(serverUrl)) return null;
  return NextResponse.json({ error: 'Your organisation does not allow this server', code: 'blocked_by_policy' }, { status: 403 });
}
