// Whether a checker plugin may get the text of the message being written.
//
// The admin decides through the settings policy, for everyone or a group:
//   `proofreading`               the setting itself: a default (on or off)
//                                or a lock (off and hidden, or on: required)
//   `proofreading.<pluginId>`    the same for one checker plugin; a lock here
//                                beats the setting's default and its lock on,
//                                but not a lock off ("no checker runs")
// Users choose within that: the setting, and per plugin
// `proofreadingPlugins[pluginId]`.
//
// The answer is worked out from the policy store each time, not from the
// settings store: a value set from the console or an old synced value can't
// turn on a checker the admin locked off, nor turn off one they require.
// Until the policy is known, nothing is checked.

import type { SettingRestriction } from '@/lib/admin/types';

export const PROOFREADING_KEY = 'proofreading';
export const pluginPolicyKey = (pluginId: string) => `${PROOFREADING_KEY}.${pluginId}`;

export interface PolicyView {
  restrictions: Record<string, SettingRestriction | undefined>;
  defaults: Record<string, unknown>;
  /** The policy for this account is known (fetched, or nothing to fetch). */
  settled: boolean;
}

export interface UserChoice {
  proofreading: boolean;
  proofreadingPlugins: Record<string, boolean>;
}

export interface CheckerAccess {
  /** Text may go to the plugin (before the per-composer switch and protection). */
  on: boolean;
  /** The admin requires it: no switch for the user. */
  forced: boolean;
  /** The admin turned it off: no switch for the user. */
  lockedOff: boolean;
  /** The admin hid the setting. */
  hidden: boolean;
}

function lockedValue(r: SettingRestriction | undefined, key: string, defaults: Record<string, unknown>): boolean | undefined {
  if (!r || r.locked !== true) return undefined;
  const value = Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : defaults[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function checkerAccess(policy: PolicyView, user: UserChoice, pluginId: string): CheckerAccess {
  const main = policy.restrictions[PROOFREADING_KEY];
  const perKey = pluginPolicyKey(pluginId);
  const per = policy.restrictions[perKey];
  const mainLock = lockedValue(main, PROOFREADING_KEY, policy.defaults);
  const perLock = lockedValue(per, perKey, policy.defaults);
  const hidden = main?.hidden === true;
  if (!policy.settled) return { on: false, forced: false, lockedOff: false, hidden };
  if (mainLock === false || perLock === false) return { on: false, forced: false, lockedOff: true, hidden };
  if (perLock === true || (mainLock === true && per?.locked !== true)) return { on: true, forced: true, lockedOff: false, hidden };
  const own = user.proofreadingPlugins[pluginId];
  const perDefault = policy.defaults[perKey];
  const choice = typeof own === 'boolean' ? own : typeof perDefault === 'boolean' ? perDefault : user.proofreading;
  return { on: choice === true, forced: false, lockedOff: false, hidden };
}

/** The setting as a whole: locked off, required, or the user's. */
export function proofreadingAccess(policy: PolicyView, user: UserChoice): CheckerAccess {
  const main = policy.restrictions[PROOFREADING_KEY];
  const lock = lockedValue(main, PROOFREADING_KEY, policy.defaults);
  const hidden = main?.hidden === true;
  if (lock === false) return { on: false, forced: false, lockedOff: true, hidden };
  if (lock === true) return { on: true, forced: true, lockedOff: false, hidden };
  return { on: policy.settled && user.proofreading === true, forced: false, lockedOff: false, hidden };
}
