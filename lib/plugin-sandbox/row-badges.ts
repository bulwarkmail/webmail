// Plugins' row badges (onEmailListItemRender) are cached per message and
// keyword state. A plugin whose answer changed for another reason (a task
// was created elsewhere) asks for a refresh with api.ui.refreshRowBadges().

let generation = 0;
let lastRefresh = 0;
const listeners = new Set<() => void>();

/** How often a refresh may happen. */
export const ROW_BADGE_REFRESH_INTERVAL_MS = 1000;

export function rowBadgeGeneration(): number {
  return generation;
}

export function subscribeRowBadges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function bump(): void {
  generation += 1;
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

/**
 * A plugin's onEmailListItemRender handler came or went: ask every row
 * again. The list usually renders before the plugins have started, and
 * those rows would otherwise never show the plugin's badges.
 */
export function rowBadgeHandlersChanged(): void {
  bump();
}

/** Ask every visible row again. At most once a second; extra calls are dropped. */
export function refreshRowBadges(now = Date.now()): boolean {
  if (now - lastRefresh < ROW_BADGE_REFRESH_INTERVAL_MS) return false;
  lastRefresh = now;
  bump();
  return true;
}

/** Test helper. */
export function resetRowBadgeRefresh(): void {
  generation = 0;
  lastRefresh = 0;
}
