/**
 * What an account keeps on this device. Three sources, in this order: the
 * organisation's policy, the user's choice, the platform's default. The policy
 * only ever lowers: nothing below it can raise a cap or turn back on what it
 * forbids, and that includes the desktop app's default of keeping mail.
 */

import { getDesktopBridge, isDesktopApp } from '@/lib/desktop/bridge';
import { DEFAULT_SCOPE, type StoreScope } from '@/lib/store/area';
import type { DevicePolicy } from '@/lib/device-policy';
import { useOfflineStore, type UserChoice } from './state';

const MB = 1024 * 1024;

/** The windows a user picks from. Null keeps everything. */
export const WINDOW_CHOICES: readonly (number | null)[] = [30, 90, 365, null];
/** The largest attachment a user may keep, in MB. */
export const ATTACHMENT_CAP_CHOICES: readonly number[] = [5, 25, 100, 500];

/** What the old offline mode kept, for those who had it on before the local store. */
export const LEGACY_CHOICE: UserChoice = { on: true, days: 30, attachments: true, maxAttachmentBytes: 5 * MB };

export interface PlatformDefault {
  on: boolean;
  /** The OS policy says so either way (desktop `OfflineEnabled`, forced): no user choice applies. */
  forced?: boolean | null;
  scope: StoreScope;
}

export interface EffectiveScope {
  account: string;
  /** Whether the account keeps mail here at all. */
  enabled: boolean;
  scope: StoreScope;
  /** What the policy decides, for the settings page: these show "Set by your organisation". */
  locked: {
    offline: boolean;
    /** The switch itself: forced on or off by the OS policy. */
    forced: boolean;
    days: boolean;
    attachments: boolean;
    maxAttachment: boolean;
    maxTotal: boolean;
  };
}

interface OfflineEnabledSetting {
  value?: unknown;
  locked?: unknown;
  source?: unknown;
}

/** `OfflineEnabled` from the desktop app's OS policies. Feature-detected: older shells have no such member. */
function offlineEnabledPolicy(): OfflineEnabledSetting | null {
  const bridge = getDesktopBridge() as { policy?: { get?: () => { OfflineEnabled?: OfflineEnabledSetting } | null | undefined } } | null;
  try {
    return bridge?.policy?.get?.()?.OfflineEnabled ?? null;
  } catch {
    return null;
  }
}

/**
 * The desktop app keeps mail without asking, unless a recommended policy says
 * otherwise. Browsers stay opt-in. Feature-detected: the bridge is only there in the app.
 */
export function offlineDefaultOn(): boolean {
  if (!isDesktopApp()) return false;
  const setting = offlineEnabledPolicy();
  if (setting && setting.source !== 'default' && typeof setting.value === 'boolean') return setting.value;
  return true;
}

export function platformDefault(): PlatformDefault {
  const setting = offlineEnabledPolicy();
  const forced = setting?.locked && typeof setting.value === 'boolean' ? setting.value : null;
  return { on: offlineDefaultOn(), forced, scope: DEFAULT_SCOPE };
}

/** Null means everything, so any cap is lower. */
function cappedDays(days: number | null, cap: number): number | null {
  if (!(cap > 0)) return days;
  return days === null ? cap : Math.min(days, cap);
}

function cappedBytes(bytes: number, capMb: number): number {
  return capMb > 0 ? Math.min(bytes, capMb * MB) : bytes;
}

export function effectiveScope(
  account: string,
  userChoice: UserChoice | null | undefined,
  policy: Pick<DevicePolicy, 'noOffline' | 'offlineMaxDays' | 'noOfflineAttachments' | 'offlineMaxAttachmentMb' | 'offlineMaxTotalMb'>,
  defaults: PlatformDefault,
): EffectiveScope {
  const choice = userChoice ?? {};
  const days = choice.days !== undefined ? choice.days : defaults.scope.days;
  const maxAttachment = choice.maxAttachmentBytes ?? defaults.scope.maxAttachmentBytes;
  return {
    account,
    enabled: !policy.noOffline && (defaults.forced ?? choice.on ?? defaults.on),
    scope: {
      days: cappedDays(days, policy.offlineMaxDays),
      attachments: !policy.noOfflineAttachments && (choice.attachments ?? defaults.scope.attachments),
      maxAttachmentBytes: cappedBytes(maxAttachment, policy.offlineMaxAttachmentMb),
      maxTotalBytes: cappedBytes(defaults.scope.maxTotalBytes, policy.offlineMaxTotalMb),
    },
    locked: {
      offline: policy.noOffline,
      forced: typeof defaults.forced === 'boolean',
      days: policy.offlineMaxDays > 0,
      attachments: policy.noOfflineAttachments,
      maxAttachment: policy.offlineMaxAttachmentMb > 0,
      maxTotal: policy.offlineMaxTotalMb > 0,
    },
  };
}

/**
 * What the user chose for an account. The switch used to be the only thing
 * stored, so an account that has it on and no choice yet was turned on under
 * the old offline mode, and keeps the window it had.
 */
export function userChoiceFor(account: string): UserChoice | null {
  const { choices, enabled } = useOfflineStore.getState();
  const stored = choices[account];
  const on = enabled.includes(account);
  if (!stored) return on ? LEGACY_CHOICE : null;
  return on && stored.on === undefined ? { ...stored, on } : stored;
}

/** The windows on offer under a cap: the ones that fit, and the cap itself when it falls between them. */
export function windowOptions(capDays: number): (number | null)[] {
  if (!(capDays > 0)) return [...WINDOW_CHOICES];
  const fit = WINDOW_CHOICES.filter((days): days is number => days !== null && days < capDays);
  return [...fit, capDays];
}

/** The attachment sizes on offer under a cap, in MB. */
export function attachmentCapOptions(capMb: number): number[] {
  if (!(capMb > 0)) return [...ATTACHMENT_CAP_CHOICES];
  const fit = ATTACHMENT_CAP_CHOICES.filter((mb) => mb < capMb);
  return [...fit, capMb];
}

export function maxAttachmentMb(scope: StoreScope): number {
  return Math.round(scope.maxAttachmentBytes / MB);
}

/** A message older than the organisation's cap isn't kept, opened or not. */
export function olderThanCap(receivedAt: unknown, capDays: number, now: number): boolean {
  if (!(capDays > 0) || typeof receivedAt !== 'string') return false;
  const at = Date.parse(receivedAt);
  return Number.isFinite(at) && at < now - capDays * 86_400_000;
}
