import { usePolicyStore } from '@/stores/policy-store';

// The admin policy's `archiveActionEnabled` gate (#1257). Installations that
// archive mail elsewhere (a mail gateway) turn the Archive action off: no
// button, menu entry, hover or swipe action, shortcut or archive-after-export,
// and no Archive folder created. Existing Archive folders stay ordinary folders.

/** Whether the Archive action is offered, for components. */
export function useArchiveActionEnabled(): boolean {
  return usePolicyStore((s) => s.isFeatureEnabled('archiveActionEnabled'));
}

/** Whether the Archive action is offered, outside React (handlers, stores). */
export function isArchiveActionEnabled(): boolean {
  return usePolicyStore.getState().isFeatureEnabled('archiveActionEnabled');
}

/** The actions without `archive` while the gate is off. */
export function withoutArchiveIfOff<T extends string>(actions: readonly T[], archiveActionEnabled: boolean): readonly T[] {
  return archiveActionEnabled ? actions : actions.filter((action) => action !== 'archive');
}
