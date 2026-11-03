/**
 * What the desktop app's telemetry and crash reports agree on across the webmail and
 * the shell: when consent counts, what a heartbeat from the shell holds, and when one
 * is due.
 *
 * No DOM, no Node, no imports: the desktop repo keeps a byte-for-byte copy in
 * src/shared/desktop-telemetry.ts. Main can't import lib/telemetry, which needs the
 * store and node:dns, and in instance mode no server runs inside the app. It holds no
 * host name either: the shell has its own constant, and lib/telemetry/types.ts has this
 * side's.
 *
 * The collector decides the shape (repos/dashboard/telemetry-collector/src/validate.ts).
 * Schema 1 drops fields it doesn't know and schema 2 refuses the whole heartbeat over
 * one, so mode and channel travel in `build`, the one free field it keeps. It stores
 * `platform: 'desktop'` as `unknown` until it has been patched.
 */

export type DesktopTelemetryMode = 'standalone' | 'instance';
export type DesktopTelemetryChannel = 'stable' | 'beta';
export type DesktopOsFamily = 'linux' | 'darwin' | 'windows' | 'unknown';

/** What main tells the embedded server, by message. Nothing in a page can write it. */
export interface DesktopServerPrivacy {
  telemetry: boolean;
  crashReports: boolean;
  /** The desktop app's version. The webmail's own is in `NEXT_PUBLIC_APP_VERSION`. */
  appVersion: string;
  /** `desktop.<mode>.<channel>`. */
  build: string;
}

/**
 * How soon after a start a heartbeat that's due goes out. The server's own hour is
 * right for a server. An app quit within an hour of every start would never send.
 */
export const DESKTOP_CATCH_UP_MS = 30_000;
/** A failed send tries again this much later, not a day later. */
export const DESKTOP_RETRY_MS = 60 * 60_000;
export const DESKTOP_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;

/** The start of a main-process frame's path. Only the shell's own bundle gets it. */
export const DESKTOP_FRAME_PREFIX = '/desktop/';
/** On the version of everything a desktop app reports. The collector's version field allows it. */
export const DESKTOP_VERSION_SUFFIX = '+desktop';

/** A policy that forces something off. A recommendation doesn't: the user's choice beats it. */
export function forcedOffByPolicy(entry: { value: boolean; locked: boolean }): boolean {
  return entry.locked && entry.value === false;
}

/**
 * Whether something opt-in is on. Only a yes counts: no answer is off, and a policy
 * allowing it still leaves the question to the user.
 */
export function consentInForce(choice: boolean | null | undefined, policy: { value: boolean; locked: boolean }): boolean {
  return choice === true && !forcedOffByPolicy(policy);
}

export function desktopBuildTag(mode: DesktopTelemetryMode, channel: DesktopTelemetryChannel): string {
  return `desktop.${mode}.${channel}`;
}

/** Forced beats the user's choice, which beats what the version says. */
export function desktopChannel(
  policy: { value: DesktopTelemetryChannel; locked: boolean },
  choice: unknown,
  appVersion: string,
): DesktopTelemetryChannel {
  if (policy.locked) return policy.value;
  if (choice === 'stable' || choice === 'beta') return choice;
  return appVersion.includes('-') ? 'beta' : 'stable';
}

export function desktopOsFamily(platform: string): DesktopOsFamily {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

/** How long until the next heartbeat, given when the last one went out. */
export function heartbeatDelayMs(lastSentAt: number | null | undefined, now: number): number {
  if (!lastSentAt || lastSentAt > now) return DESKTOP_CATCH_UP_MS;
  return Math.max(DESKTOP_CATCH_UP_MS, lastSentAt + DESKTOP_HEARTBEAT_INTERVAL_MS - now);
}

export interface DesktopPingInput {
  /** The shell's own UUID, never an instance's. */
  instanceId: string;
  appVersion: string;
  nodeVersion: string;
  osFamily: DesktopOsFamily;
  mode: DesktopTelemetryMode;
  channel: DesktopTelemetryChannel;
  now: number;
}

/**
 * The shell's own heartbeat, for when no server runs inside the app. Features and counts
 * are the instance's to report, so these are all empty and nothing is counted twice.
 */
export function buildDesktopPing(input: DesktopPingInput) {
  return {
    schema: '1' as const,
    instance_id: input.instanceId,
    ts: new Date(input.now).toISOString(),
    version: input.appVersion,
    build: desktopBuildTag(input.mode, input.channel),
    platform: 'desktop',
    node_version: input.nodeVersion,
    os_family: input.osFamily,
    stalwart_version: null,
    features: { calendar: false, contacts: false, files: false, extensions: false, oauth_enabled: false, smime_enabled: false },
    counts: { accounts: '0', accounts_active_7d: '0', extensions_installed: 0, themes_installed: 0 },
    uptime_days: 0,
  };
}

export function desktopErrorCountBucket(count: number): string {
  if (count <= 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 10) return '6-10';
  if (count <= 50) return '11-50';
  if (count <= 200) return '51-200';
  return '201+';
}

export interface DesktopMainError {
  name: string;
  /** 16 hex digits. */
  fingerprint: string;
  version: string;
  count: number;
}

/**
 * Main's errors when no server runs inside the app: the collector's /v1/errors takes
 * this without a heartbeat, so it works with telemetry off. Name and count only. The
 * collector refuses a whole batch over a frame outside the webmail's bundles.
 */
export function buildDesktopErrorBatch(instanceId: string, now: number, errors: readonly DesktopMainError[]) {
  return {
    schema: '1' as const,
    instance_id: instanceId,
    day: new Date(now).toISOString().slice(0, 10),
    errors: errors.map((error) => ({
      name: error.name,
      fingerprint: error.fingerprint,
      frames: [],
      version: error.version,
      count: desktopErrorCountBucket(error.count),
      days: 1,
    })),
  };
}
