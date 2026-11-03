/**
 * The desktop app's OS policies for the lock, read through the bridge. In a browser
 * there's no bridge and nothing is required. The bridge's `policy` member comes from
 * another package, so it is feature detected, as lib/offline/scope.ts does.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { DEFAULT_TIMEOUT_MINUTES } from './state';

interface PolicyEntry<T> {
  value: T;
  locked: boolean;
  source: string;
}

interface LockPolicies {
  AppLockRequired?: PolicyEntry<boolean>;
  AppLockTimeoutMinutes?: PolicyEntry<number | null>;
}

interface PolicyBridge {
  get?: () => LockPolicies | null | undefined;
  onChange?: (listener: (snapshot: LockPolicies) => void) => () => void;
}

function policyBridge(): PolicyBridge | undefined {
  return (getDesktopBridge() as { policy?: PolicyBridge } | null)?.policy;
}

function read(): LockPolicies {
  try {
    return policyBridge()?.get?.() ?? {};
  } catch {
    return {};
  }
}

/** Only a forced value requires it: a recommended one can't choose a PIN for anyone. */
export function appLockRequired(): boolean {
  const entry = read().AppLockRequired;
  return entry?.locked === true && entry.value === true;
}

export interface EffectiveTimeout {
  minutes: number;
  /** Set by the organisation: the user's choice doesn't apply. */
  locked: boolean;
}

/** Forced, then the user's choice, then recommended, then the default. */
export function effectiveTimeout(choice: number | undefined): EffectiveTimeout {
  const entry = read().AppLockTimeoutMinutes;
  const value = typeof entry?.value === 'number' && entry.value > 0 ? entry.value : null;
  if (entry?.locked && value !== null) return { minutes: value, locked: true };
  return { minutes: choice ?? value ?? DEFAULT_TIMEOUT_MINUTES, locked: false };
}

export function onLockPolicyChange(listener: () => void): () => void {
  try {
    return policyBridge()?.onChange?.(() => listener()) ?? (() => {});
  } catch {
    return () => {};
  }
}
