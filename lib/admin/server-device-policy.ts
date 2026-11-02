/**
 * The device policies (policy.json `organisation.devices`) as the server
 * applies them itself, where it can: the push notification text
 * (app/api/push/preview) and the office editor (app/api/wopi). The browser
 * talks to the mail server directly for everything else, so those gates
 * are browser-only (lib/device-policy.ts).
 *
 * Who the caller is comes from their own JMAP session, never from the
 * browser. For these gates every non-personal account in the session
 * counts as a group (a mailbox another person shared counts too): more
 * scopes matched means more held back, the safe direction. A session that
 * can't be read counts the login address alone.
 */

import { createHash } from 'node:crypto';
import { configManager } from './config-manager';
import { DEFAULT_ORGANISATION_POLICY, type OrganisationPolicy } from './organisation-policy';
import { resolvePolicy, type PolicySubject } from './policy-scopes';
import type { SettingsPolicy } from './types';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';

export type ServerDevicePolicy = OrganisationPolicy['devices'];

export interface DeviceCreds {
  serverUrl: string;
  authHeader: string;
  username: string;
  accountName?: string;
  trusted: boolean;
}

const TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = Symbol.for('bulwark.serverDeviceSubjects');

// One cache per process, not per bundle copy.
function cache(): Map<string, { at: number; subject: Promise<PolicySubject | null> }> {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<string, { at: number; subject: Promise<PolicySubject | null> }> };
  g[CACHE_KEY] ??= new Map();
  return g[CACHE_KEY];
}

/** The subject from the login's session; null when the session couldn't be read. */
async function readSubject(creds: DeviceCreds): Promise<PolicySubject | null> {
  const email = (creds.accountName || creds.username || '').trim().toLowerCase();
  const session = await fetchJmapSession(creds.serverUrl, creds.authHeader, { trusted: creds.trusted }).catch(() => null);
  if (!session) return null;
  const accounts = (session?.accounts ?? {}) as Record<string, { name?: string; isPersonal?: boolean }>;
  const groups = Object.values(accounts)
    .filter((account) => account?.isPersonal === false && typeof account.name === 'string' && account.name.includes('@'))
    .map((account) => account.name!.trim().toLowerCase())
    .filter((name) => name !== email)
    .sort();
  return { email, groups };
}

/**
 * The caller as the device gates see them, kept for a few minutes per
 * credential; null when the session couldn't be read, which isn't kept, so
 * the next request asks again. Never rejects.
 */
export function strictDeviceSubject(creds: DeviceCreds): Promise<PolicySubject | null> {
  const key = createHash('sha256').update(`${creds.serverUrl}\n${creds.authHeader}`).digest('hex');
  const entries = cache();
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.subject;
  const subject = readSubject(creds).catch(() => null);
  entries.set(key, { at: now, subject });
  void subject.then((value) => {
    if (value === null && entries.get(key)?.subject === subject) entries.delete(key);
  });
  if (entries.size > 1000) {
    for (const [k, v] of entries) if (now - v.at >= TTL_MS) entries.delete(k);
  }
  return subject;
}

/** Every switch that Everyone or any scope turns on: for a login whose scopes can't be worked out. */
export function strictestOfAllScopes(policy: SettingsPolicy): ServerDevicePolicy {
  const out: ServerDevicePolicy = { ...DEFAULT_ORGANISATION_POLICY.devices, ...(resolvePolicy(policy, null).policy.organisation?.devices ?? {}) };
  for (const scope of policy.scopes ?? []) {
    const devices = scope.policy?.organisation?.devices as Partial<ServerDevicePolicy> | undefined;
    if (!devices) continue;
    for (const key of Object.keys(out) as (keyof ServerDevicePolicy)[]) if (devices[key] === true) out[key] = true;
  }
  return out;
}

/** Everything on: when not even the policy can be read. */
export const ALL_DEVICE_LIMITS: ServerDevicePolicy = Object.fromEntries(
  Object.keys(DEFAULT_ORGANISATION_POLICY.devices).map((key) => [key, true]),
) as ServerDevicePolicy;

/**
 * The device policy that applies to this login. When its session can't be
 * read (a server error, an expired token in an old office editor link),
 * the strictest of every scope applies: a group scope's switch must not
 * lapse because its members couldn't be looked up.
 */
export async function serverDevicePolicy(creds: DeviceCreds): Promise<ServerDevicePolicy> {
  await configManager.ensureLoaded();
  const policy = configManager.getPolicy();
  const subject = await strictDeviceSubject(creds);
  if (!subject) return strictestOfAllScopes(policy);
  const devices = resolvePolicy(policy, subject).policy.organisation?.devices;
  return { ...DEFAULT_ORGANISATION_POLICY.devices, ...(devices ?? {}) };
}

/**
 * The WOPI CheckFileInfo switches for the office editor (Collabora and
 * ONLYOFFICE read these): no printing, no export or "save a copy" when
 * downloads or export are off, and the watermark.
 */
export function wopiDeviceInfo(devices: ServerDevicePolicy, username: string, now: Date = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (devices.noPrint) {
    out.DisablePrint = true;
    out.HidePrintOption = true;
  }
  if (devices.noDownloads || devices.noExport) {
    out.DisableExport = true;
    out.HideExportOption = true;
    out.HideSaveOption = true;
    out.DisableCopy = true;
  }
  if (devices.watermark) out.WatermarkText = `${username} · ${now.toISOString().slice(0, 10)}`;
  return out;
}

/** For tests. */
export function clearServerDeviceSubjects(): void {
  cache().clear();
}
