import { hookSpec } from '@/lib/plugin-hook-catalog';
import { emailHooks } from '@/lib/plugin-hooks';

/** The hooks that can stop what a notification's buttons do. */
const VETO_HOOKS = ['onBeforeEmailMove', 'onBeforeEmailArchive', 'onBeforeEmailReadStateChange'] as const;

/** Whether one of these plugins could register one of those hooks, today or after a page load. */
export function pluginsMayVeto(plugins: ReadonlyArray<{ enabled?: boolean; permissions?: readonly unknown[] }>): boolean {
  const needed = new Set(VETO_HOOKS.map((name) => hookSpec(name)?.permission));
  return plugins.some((plugin) => plugin.enabled && plugin.permissions?.some((permission) => needed.has(permission as never)));
}

/** Whether a plugin in this tab listens on one of those hooks now. */
export function vetoHooksRegistered(): boolean {
  return VETO_HOOKS.some((name) => emailHooks[name].size > 0);
}
