'use client';

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useManagedSidebarApps, useResolvedSidebarApps } from '@/hooks/use-resolved-sidebar-apps';
import { useStrictestDevices } from '@/hooks/use-device-policy';
import { appFrameRights } from '@/lib/sidebar-apps';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSidebarAppFramesStore } from '@/stores/sidebar-app-frames-store';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Follows an element's place in the viewport while there is one. */
function useViewportBox(el: HTMLElement | null): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    if (!el) {
      setBox(null);
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height }
      );
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    observer?.observe(document.documentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [el]);
  return box;
}

/**
 * The frames of inline sidebar apps, for the whole tab. A page shows an app by
 * giving its pane to the store (InlineAppView) and the frame is laid over that
 * pane, so moving between Mail, Calendar and the other pages keeps the app's
 * document: its session, its socket and whatever was typed into it.
 */
export function SidebarAppFramesHost() {
  const frames = useSidebarAppFramesStore((s) => s.frames);
  const shown = useSidebarAppFramesStore((s) => s.shown);
  const managedApps = useManagedSidebarApps();
  const resolvedApps = useResolvedSidebarApps();
  const downloadsOff = useStrictestDevices().noDownloads;
  const box = useViewportBox(shown?.slot ?? null);

  // Until an app's first load its frame holds the initial about:blank. That
  // document's color scheme is "normal" while the frame element inherits the
  // theme's, and CSS Color Adjust gives such a mismatch an opaque canvas: in a
  // dark theme WebKit paints the app area white until the app arrives (#1517).
  // Each frame stays invisible until it has loaded, so the pane's background
  // shows meanwhile.
  const [loadedAppIds, setLoadedAppIds] = useState<ReadonlySet<string>>(() => new Set());
  const markLoaded = (appId: string) =>
    setLoadedAppIds((prev) => (prev.has(appId) ? prev : new Set(prev).add(appId)));
  // A frame that goes and comes back starts again from about:blank.
  useEffect(() => {
    setLoadedAppIds((prev) => {
      const kept = [...prev].filter((id) => frames.some((f) => f.id === id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [frames]);

  // An app removed from the rail, or pointed elsewhere, loses its frame. The
  // operator's apps arrive with the policy, so nothing is dropped before it.
  const policyLoaded = usePolicyStore((s) => s.loaded);
  const inlineApps = useMemo(
    () => resolvedApps.filter((a) => a.openMode === 'inline').map((a) => ({ id: a.id, url: a.url, name: a.name })),
    [resolvedApps]
  );
  useEffect(() => {
    if (policyLoaded) useSidebarAppFramesStore.getState().prune(inlineApps);
  }, [inlineApps, policyLoaded]);

  // Signing out ends every app's frame, so the next account starts without them.
  useEffect(
    () =>
      useAuthStore.subscribe((state, prev) => {
        if (prev.isAuthenticated && !state.isAuthenticated) {
          useSidebarAppFramesStore.setState({ frames: [] });
        }
      }),
    []
  );

  if (frames.length === 0) return null;

  const activeAppId = shown && box ? shown.appId : null;

  return (
    <div
      data-sidebar-app-frames=""
      className={cn('fixed', !activeAppId && 'hidden')}
      style={box ? { top: box.top, left: box.left, width: box.width, height: box.height } : undefined}
    >
      {frames.map((app) => {
        const rights = appFrameRights(app, managedApps, { downloadsOff });
        return (
          <iframe
            key={app.id}
            src={app.url}
            title={app.name}
            className={cn(
              'absolute inset-0 w-full h-full border-0',
              app.id !== activeAppId && 'hidden',
              !loadedAppIds.has(app.id) && 'invisible'
            )}
            sandbox={rights.sandbox}
            allow={rights.allow}
            referrerPolicy="no-referrer"
            onLoad={() => markLoaded(app.id)}
          />
        );
      })}
    </div>
  );
}
