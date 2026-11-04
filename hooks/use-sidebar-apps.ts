import { isAppLockOn } from '@/lib/app-lock/state';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { useManagedSidebarApps } from '@/hooks/use-resolved-sidebar-apps';
import { appUrlToFrameOrigin, inlineAppFrameOrigins } from '@/lib/security/app-frame-origins';
import { readAppFrameOrigins, writeAppFrameOrigins } from '@/lib/security/app-frame-origins-client';
import { sidebarAppHooks } from '@/lib/plugin-hooks';

export interface InlineAppState {
  id: string;
  url: string;
  name: string;
}

// An app opened right after its origin was added to the CSP cookie survives the
// reload here, so the user's click still ends up opening the app.
const PENDING_APP_KEY = 'bulwark:pending-inline-app';

function takePendingInlineApp(): InlineAppState | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PENDING_APP_KEY);
    if (!raw) return null;
    // Removed before use: whoever reads it first owns it, and a failed open
    // never replays on the next reload.
    sessionStorage.removeItem(PENDING_APP_KEY);
    const parsed = JSON.parse(raw) as Partial<InlineAppState>;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.url !== 'string') return null;
    return { id: parsed.id, url: parsed.url, name: typeof parsed.name === 'string' ? parsed.name : '' };
  } catch {
    return null;
  }
}

export function useSidebarApps() {
  const [showAppsModal, setShowAppsModal] = useState(false);
  const [inlineApp, setInlineApp] = useState<InlineAppState | null>(null);
  const [loadedApps, setLoadedApps] = useState<InlineAppState[]>([]);
  const keepAppsLoaded = useSettingsStore((s) => s.keepAppsLoaded);
  const sidebarApps = useSettingsStore((s) => s.sidebarApps);
  const managedApps = useManagedSidebarApps();

  // The `frame-src` origins this document's CSP was built from. The header is
  // fixed for the life of the document, so this snapshot - taken before we
  // write any update - is what the browser will actually allow to be framed.
  const appliedOriginsRef = useRef<string[] | null>(null);

  // Admin-pinned apps are in `frame-src` already - the proxy reads them from
  // the policy on every document request - so they never need the cookie, and
  // opening one must not trigger the reload below.
  const managedOrigins = useMemo(() => inlineAppFrameOrigins(managedApps), [managedApps]);

  // Plugins hear when an app opens, and when it closes: closed by the user,
  // replaced by another app, or gone because the user left the page.
  const inlineAppId = inlineApp?.id ?? null;
  useEffect(() => {
    if (!inlineAppId) return;
    void sidebarAppHooks.onSidebarAppOpen.emit({ appId: inlineAppId });
    return () => { void sidebarAppHooks.onSidebarAppClose.emit({ appId: inlineAppId }); };
  }, [inlineAppId]);

  const openInlineApp = useCallback((app: InlineAppState) => {
    setInlineApp(app);
    setLoadedApps((prev) => (prev.some((a) => a.id === app.id) ? prev : [...prev, app]));
  }, []);

  useEffect(() => {
    if (appliedOriginsRef.current === null) {
      appliedOriginsRef.current = readAppFrameOrigins();
    }
    const pending = takePendingInlineApp();
    if (pending) openInlineApp(pending);
  }, [openInlineApp]);

  // Keep the cookie in step with the configured apps so the next document load
  // gets a CSP that covers them.
  useEffect(() => {
    if (appliedOriginsRef.current === null) {
      appliedOriginsRef.current = readAppFrameOrigins();
    }
    writeAppFrameOrigins(inlineAppFrameOrigins(sidebarApps));
  }, [sidebarApps]);

  const handleManageApps = useCallback(() => {
    setShowAppsModal(true);
  }, []);

  const handleInlineApp = useCallback((appId: string, url: string, name: string) => {
    const app = { id: appId, url, name };
    const origin = appUrlToFrameOrigin(url);
    const applied = [...(appliedOriginsRef.current ?? readAppFrameOrigins()), ...managedOrigins];

    // Newly added app (or one added in another tab): its origin isn't in this
    // document's frame-src, so the iframe would be blocked. Publish it and
    // reload to pick up a CSP that allows it. If the cookie can't be written
    // we fall through and open anyway rather than reload forever.
    if (origin && !applied.includes(origin)) {
      const origins = inlineAppFrameOrigins(sidebarApps);
      if (!origins.includes(origin)) origins.push(origin);
      if (writeAppFrameOrigins(origins)) {
        // Only a new document gets the new CSP, and with the app lock on that would ask for
        // the PIN just to open an app. So this once it opens beside the app, and in place
        // from the next start on.
        if (isAppLockOn()) {
          window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        try {
          sessionStorage.setItem(PENDING_APP_KEY, JSON.stringify(app));
        } catch {
          // Private mode / storage full - the app just won't reopen itself.
        }
        // full-load: a document's frame-src can't change without a new document.
        window.location.reload();
        return;
      }
    }

    openInlineApp(app);
  }, [sidebarApps, managedOrigins, openInlineApp]);

  const closeInlineApp = useCallback(() => {
    if (!keepAppsLoaded) {
      setLoadedApps((prev) => prev.filter((a) => a.id !== inlineApp?.id));
    }
    setInlineApp(null);
  }, [keepAppsLoaded, inlineApp]);

  const closeAppsModal = useCallback(() => {
    setShowAppsModal(false);
  }, []);

  return {
    showAppsModal,
    inlineApp,
    loadedApps: keepAppsLoaded ? loadedApps : (inlineApp ? [inlineApp] : []),
    handleManageApps,
    handleInlineApp,
    closeInlineApp,
    closeAppsModal,
  };
}
