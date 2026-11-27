'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useManagedSidebarApps, useResolvedSidebarApps } from '@/hooks/use-resolved-sidebar-apps';
import { useStrictestDevices } from '@/hooks/use-device-policy';
import { appFrameRights } from '@/lib/sidebar-apps';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import {
  parseAppBadgeMessage,
  SILENT_MS,
  SILENT_RELOAD_MS,
  useSidebarAppFramesStore,
  type AppBadgeStatus,
} from '@/stores/sidebar-app-frames-store';

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

/** The least time between two loads of a frame anew (the badge's states). */
export const RELOAD_GAP_MS = 5_000;

/**
 * Calls back when the user comes back to this window: it has the focus again
 * from another window, or the tab is shown again. Not when the focus only
 * comes back from one of the page's own frames (the user clicked out of the
 * app into Bulwark), which would load anew an app they just typed into.
 */
function useWindowReturn(onReturn: () => void) {
  const latest = useRef(onReturn);
  useEffect(() => {
    latest.current = onReturn;
  });
  useEffect(() => {
    let intoFrame = false;
    let check: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      // Where the focus went is known only once the blur is over.
      check = setTimeout(() => {
        intoFrame = document.activeElement instanceof HTMLIFrameElement;
      }, 0);
    };
    const onFocus = () => {
      clearTimeout(check);
      const fromFrame = intoFrame;
      intoFrame = false;
      if (!fromFrame) latest.current();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(check);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

/**
 * The frames of inline sidebar apps, for the whole tab. A page shows an app by
 * giving its pane to the store (InlineAppView) and the frame is laid over that
 * pane, so moving between Mail, Calendar and the other pages keeps the app's
 * document: its session, its socket and whatever was typed into it.
 *
 * Apps may report an unread count to the rail with a `bulwark:app-badge`
 * message. Only the app's own frame is heard, and only from the app's origin.
 */
export function SidebarAppFramesHost() {
  const frames = useSidebarAppFramesStore((s) => s.frames);
  const shown = useSidebarAppFramesStore((s) => s.shown);
  const managedApps = useManagedSidebarApps();
  const resolvedApps = useResolvedSidebarApps();
  const downloadsOff = useStrictestDevices().noDownloads;
  const box = useViewportBox(shown?.slot ?? null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  /** Each app's frame element as last made, to tell a new frame from a render. */
  const made = useRef(new Map<string, HTMLIFrameElement>());

  // Silence: an app of the policy with `badge: true` promises to report. From
  // its frame's making and each load until its first message, at most
  // SILENT_MS, else it is `silent` (unreachable, its reporting part missing,
  // the frame refused). Only then: an app reports when it starts and then
  // only on a change, so a quiet app that said "ok" stays so.
  const reports = (appId: string) => managedApps.some((a) => a.id === appId && a.badge === true);
  const silence = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const heard = (appId: string) => {
    clearTimeout(silence.current.get(appId));
    silence.current.delete(appId);
  };
  const listen = (appId: string) => {
    if (!reports(appId)) return;
    heard(appId);
    silence.current.set(
      appId,
      setTimeout(() => {
        silence.current.delete(appId);
        const store = useSidebarAppFramesStore.getState();
        const last = store.badges[appId];
        store.setBadge(appId, {
          count: last?.count ?? 0,
          ...(last?.mentions !== undefined ? { mentions: last.mentions } : {}),
          state: 'silent',
        });
      }, SILENT_MS)
    );
  };
  useEffect(() => {
    for (const appId of [...silence.current.keys()]) {
      if (!frames.some((f) => f.id === appId)) heard(appId);
    }
  }, [frames]);
  useEffect(() => {
    const timers = silence.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // A frame whose app is signed out or silent is loaded anew when the user
  // comes back to the window, a silent one also every SILENT_RELOAD_MS:
  // signed in elsewhere, or the app reachable again, the count returns. The
  // state stays until the new document says otherwise, so nothing flashes.
  const lastLoad = useRef(new Map<string, number>());
  const loadAnew = (states: readonly AppBadgeStatus[]) => {
    const { badges, frames: live } = useSidebarAppFramesStore.getState();
    for (const app of live) {
      const frame = frameRefs.current.get(app.id);
      const state = badges[app.id]?.state;
      if (!frame || !state || !states.includes(state)) continue;
      const now = Date.now();
      if (now - (lastLoad.current.get(app.id) ?? 0) < RELOAD_GAP_MS) continue;
      lastLoad.current.set(app.id, now);
      // Setting src navigates even to the same URL; a cross-origin frame cannot be told to reload.
      frame.src = frame.getAttribute('src') ?? app.url;
    }
  };
  useWindowReturn(() => loadAnew(['signed-out', 'silent']));
  const anySilent = useSidebarAppFramesStore((s) => Object.values(s.badges).some((b) => b.state === 'silent'));
  useEffect(() => {
    if (!anySilent) return;
    const timer = setInterval(() => loadAnew(['silent']), SILENT_RELOAD_MS);
    return () => clearInterval(timer);
    // loadAnew reads only refs and the store.
  }, [anySilent]);

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
          useSidebarAppFramesStore.setState({ frames: [], badges: {} });
        }
      }),
    []
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!event.source) return;
      for (const app of useSidebarAppFramesStore.getState().frames) {
        const frame = frameRefs.current.get(app.id);
        if (!frame || frame.contentWindow !== event.source) continue;
        let origin: string;
        try {
          origin = new URL(app.url).origin;
        } catch {
          return;
        }
        if (event.origin !== origin) return;
        const badge = parseAppBadgeMessage(event.data);
        if (badge === undefined) return;
        heard(app.id);
        useSidebarAppFramesStore.getState().setBadge(app.id, badge);
        return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // `heard` reads only a ref.
  }, []);

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
            ref={(el) => {
              if (!el) {
                frameRefs.current.delete(app.id);
                return;
              }
              frameRefs.current.set(app.id, el);
              // A new frame is waited for from now: Firefox fires no `load` for a
              // frame whose address refuses the connection. (React calls an inline
              // ref again on every render, with null first: only a frame not seen.)
              if (made.current.get(app.id) === el) return;
              made.current.set(app.id, el);
              listen(app.id);
            }}
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
            onLoad={() => {
              markLoaded(app.id);
              listen(app.id);
            }}
          />
        );
      })}
    </div>
  );
}
