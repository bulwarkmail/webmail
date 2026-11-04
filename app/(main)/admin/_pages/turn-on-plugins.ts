import { apiFetch } from '@/lib/browser-navigation';
import type { SettingsPolicy } from '@/lib/admin/types';

export interface TurnOnQuestion {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
}

export type TurnOnOutcome = 'already-on' | 'turned-on' | 'left-off' | 'failed';

export const TURN_ON_PLUGINS_QUESTION: TurnOnQuestion = {
  title: 'Turn on plugins for users too?',
  message: 'Plugins are off for users, so this plugin won\'t run for anyone until you turn them on. You can change this later on the Plugins page.',
  confirmText: 'Turn on',
  cancelText: 'Leave off',
};

/**
 * After a plugin is installed: if plugins are off for users (the
 * pluginsEnabled gate), ask whether to turn them on, and do it on a yes.
 * Without this an admin installs from the marketplace and nothing happens
 * for anyone, with the switch at the bottom of another page.
 */
export async function offerToTurnOnPlugins(
  confirm: (question: TurnOnQuestion) => boolean | Promise<boolean>,
): Promise<TurnOnOutcome> {
  try {
    const res = await apiFetch('/api/admin/policy');
    if (!res.ok) return 'failed';
    const etag = res.headers.get('ETag');
    const policy = (await res.json()) as SettingsPolicy;
    if (policy.features?.pluginsEnabled) return 'already-on';
    if (!(await confirm(TURN_ON_PLUGINS_QUESTION))) return 'left-off';
    const saved = await apiFetch('/api/admin/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
      body: JSON.stringify({ ...policy, features: { ...policy.features, pluginsEnabled: true } }),
    });
    return saved.ok ? 'turned-on' : 'failed';
  } catch {
    return 'failed';
  }
}

/** The line added to the "installed" message for each outcome. */
export function turnOnNote(outcome: TurnOnOutcome): string {
  switch (outcome) {
    case 'turned-on': return ' Plugins are now on for users.';
    case 'left-off': return ' Plugins are still off for users, so it doesn\'t run yet.';
    case 'failed': return ' Plugins could not be turned on for users; check the Plugins page.';
    default: return '';
  }
}
