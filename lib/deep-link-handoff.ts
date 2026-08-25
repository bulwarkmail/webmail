import type { AppSurface } from '@/lib/deep-links';

/**
 * Handoff for a deep link that has to survive a route change (#733).
 *
 * The Pro shell owns a single route (`/pro`) and renders each surface inside a
 * tab, so a permalink like `/mail/message/<id>` can't reach the surface as a
 * route param: ProInterfaceRedirect intercepts it and replaces the URL. It
 * parks the segments here, opens the right tab, and the surface picks them up
 * on mount - exactly like `protocol-handlers/session` does for `mailto:`.
 *
 * Surfaces in the Pro shell stay mounted for the whole session, so a link that
 * arrives *while the shell is already running* (an in-app link to
 * `/settings/folders`, a `mailto:`-style handoff, ...) would be parked and
 * never seen - the mount-time consume has long since run. For that case a
 * mounted surface subscribes here: when a listener exists, `setPendingDeepLink`
 * delivers the segments to it directly instead of parking them.
 *
 * Module state, deliberately: it must not survive a reload (the URL is gone by
 * then, so re-applying it would reopen something the user already closed).
 */
const pending = new Map<AppSurface, string[]>();

type PendingDeepLinkListener = (segments: string[]) => void;

const listeners = new Map<AppSurface, Set<PendingDeepLinkListener>>();

export function setPendingDeepLink(surface: AppSurface, segments: string[]): void {
  const live = listeners.get(surface);
  if (live && live.size > 0) {
    // A mounted surface is listening - deliver instead of parking, so links
    // arriving while the Pro shell is already running still land.
    for (const listener of [...live]) listener(segments);
    return;
  }
  pending.set(surface, segments);
}

/** Returns the parked segments once, then forgets them. */
export function consumePendingDeepLink(surface: AppSurface): string[] | null {
  const segments = pending.get(surface);
  if (!segments) return null;
  pending.delete(surface);
  return segments;
}

/**
 * Live delivery for an already-mounted surface (the Pro shell keeps surfaces
 * mounted for the whole session). Returns the unsubscribe function. Only the
 * embedded (Pro) instance of a surface should subscribe - during a cold-load
 * redirect the standard instance briefly renders too and must not steal the
 * link parked for the Pro instance that mounts right after.
 */
export function subscribePendingDeepLink(
  surface: AppSurface,
  listener: PendingDeepLinkListener,
): () => void {
  let set = listeners.get(surface);
  if (!set) {
    set = new Set();
    listeners.set(surface, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export function clearPendingDeepLinks(): void {
  pending.clear();
}
