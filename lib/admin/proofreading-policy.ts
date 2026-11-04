// The admin's choice for proofreading, as the four states the Organisation >
// Proofreading page offers, and how each is written to the settings policy
// (lib/proofreading/gate.ts reads it back on the client):
//
//   off-locked   restriction { locked, value: false, hidden }   no checker runs, the setting is hidden
//   off          default false                                  users turn it on
//   on           default true                                   users may turn it off
//   on-locked    restriction { locked, value: true }            required, users can't turn it off
//
// Per checker plugin (`proofreading.<pluginId>`): follow the setting above,
// off and locked, or on and required.

import type { SettingRestriction } from './types';

export type ProofreadingState = 'off-locked' | 'off' | 'on' | 'on-locked';
export type PluginProofreadingState = 'follow' | 'off-locked' | 'on-locked';

export const PROOFREADING_STATES: readonly { value: ProofreadingState; label: string }[] = [
  { value: 'off-locked', label: 'Off, locked (hidden for users)' },
  { value: 'off', label: 'Off by default, users can turn it on' },
  { value: 'on', label: 'On by default, users can turn it off' },
  { value: 'on-locked', label: 'On, required' },
];

export const PLUGIN_STATES: readonly { value: PluginProofreadingState; label: string }[] = [
  { value: 'follow', label: 'Follow the setting above' },
  { value: 'off-locked', label: 'Off, locked' },
  { value: 'on-locked', label: 'On, required' },
];

/** The state a restriction and default stand for. */
export function proofreadingState(restriction: SettingRestriction | undefined, preset: unknown): ProofreadingState {
  if (restriction?.locked) return restriction.value === true ? 'on-locked' : 'off-locked';
  return preset === true ? 'on' : 'off';
}

/** What to store for a state: the restriction and the default. */
export function proofreadingPolicyFor(state: ProofreadingState): { restriction: SettingRestriction | undefined; preset: boolean } {
  switch (state) {
    case 'off-locked': return { restriction: { locked: true, value: false, hidden: true }, preset: false };
    case 'off': return { restriction: undefined, preset: false };
    case 'on': return { restriction: undefined, preset: true };
    case 'on-locked': return { restriction: { locked: true, value: true }, preset: true };
  }
}

export function pluginProofreadingState(restriction: SettingRestriction | undefined): PluginProofreadingState {
  if (!restriction?.locked) return 'follow';
  return restriction.value === true ? 'on-locked' : 'off-locked';
}

export function pluginRestrictionFor(state: PluginProofreadingState): SettingRestriction | undefined {
  if (state === 'follow') return undefined;
  return { locked: true, value: state === 'on-locked' };
}

/**
 * Whether proofreading is required somewhere without a checker plugin the
 * admin forced on: users could then turn the plugin off in Add-ons, and with
 * it the check. Returns the checker plugins to offer forcing on.
 */
export function checkersToForce(
  main: ProofreadingState,
  pluginStates: Record<string, PluginProofreadingState>,
  checkers: readonly { id: string; enabled: boolean; forceEnabled?: boolean }[],
): string[] {
  const forced = (id: string) => checkers.some((c) => c.id === id && c.enabled && c.forceEnabled);
  const needed = new Set<string>();
  for (const [id, state] of Object.entries(pluginStates)) {
    if (state === 'on-locked' && main !== 'off-locked' && !forced(id)) needed.add(id);
  }
  // The setting required as a whole: one checker forced on is enough.
  const candidates = checkers.filter((c) => (pluginStates[c.id] ?? 'follow') === 'follow');
  if (main === 'on-locked' && !candidates.some((c) => forced(c.id))) {
    for (const c of candidates) needed.add(c.id);
  }
  return [...needed];
}
