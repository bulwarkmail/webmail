'use client';

// Window, navigation and app lifecycle events for plugins. Mounted once in
// the localized layout, so plugins hear about them on every page; they used
// to be wired inside the mail view and stopped in Calendar, Contacts, Files
// and Settings.

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { appLifecycleHooks, routerHooks, toastHooks, uiHooks } from '@/lib/plugin-hooks';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';

/** How often onInterval fires. */
export const PLUGIN_INTERVAL_MS = 60_000;

type SelectionSource = 'email-body' | 'composer' | 'task-detail' | 'event-detail' | 'other';

function selectionSource(anchorEl: Element | null): { source: SelectionSource; emailId?: string } {
  if (!anchorEl) return { source: 'other' };
  if (anchorEl.closest('[data-plugin-source="email-body"], iframe.email-body, .email-viewer-body')) {
    const idEl = anchorEl.closest('[data-email-id]') as HTMLElement | null;
    return { source: 'email-body', emailId: idEl?.dataset.emailId };
  }
  if (anchorEl.closest('[data-plugin-source="composer"], .email-composer')) return { source: 'composer' };
  if (anchorEl.closest('[data-plugin-source="task-detail"]')) return { source: 'task-detail' };
  if (anchorEl.closest('[data-plugin-source="event-detail"]')) return { source: 'event-detail' };
  return { source: 'other' };
}

export function PluginAppEvents() {
  // Window and document events.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => { void appLifecycleHooks.onWindowFocus.emit({}); };
    const onBlur = () => { void appLifecycleHooks.onWindowBlur.emit({}); };
    const onOnline = () => { void appLifecycleHooks.onOnline.emit({}); };
    const onOffline = () => { void appLifecycleHooks.onOffline.emit({}); };
    const onVisibility = () => {
      void appLifecycleHooks.onVisibilityChange.emit({ visible: document.visibilityState === 'visible' });
    };
    // Synchronous: the page may be gone before an async handler runs.
    const onBeforeUnload = () => { appLifecycleHooks.onBeforeUnload.emitSync({}); };
    const onError = (event: ErrorEvent) => {
      void appLifecycleHooks.onAppError.emit({ message: String(event.message || 'Unknown error').slice(0, 500) });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? 'Unhandled rejection');
      void appLifecycleHooks.onAppError.emit({ message: reason.slice(0, 500) });
    };

    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = () => {
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (uiHooks.onTextSelectionChange.size === 0) return;
        const sel = document.getSelection();
        const text = sel?.toString() ?? '';
        if (!text) return;
        const anchorNode = sel?.anchorNode as Node | null;
        const anchorEl = (anchorNode?.nodeType === Node.ELEMENT_NODE
          ? anchorNode as Element
          : anchorNode?.parentElement) ?? null;
        void uiHooks.onTextSelectionChange.emit({ text, ...selectionSource(anchorEl) });
      }, 150);
    };

    const onSwMessage = (e: MessageEvent) => {
      const msg = e.data as { kind?: string; tag?: string; data?: unknown } | null;
      if (msg && msg.kind === 'notificationclick' && typeof msg.tag === 'string') {
        // App notifications (new mail, reminders): the tag only. Their data
        // names messages and events, which this hook's permission doesn't cover.
        void toastHooks.onNotificationClick.emit({ tag: msg.tag });
      }
    };

    const interval = setInterval(() => { void appLifecycleHooks.onInterval.emit({ now: new Date().toISOString() }); }, PLUGIN_INTERVAL_MS);

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('selectionchange', onSelectionChange);
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('selectionchange', onSelectionChange);
      if (selectionTimer) clearTimeout(selectionTimer);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, []);

  // Navigation between pages of the app.
  const pathname = usePathname();
  const prevPathnameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname) return;
    const from = prevPathnameRef.current;
    if (from === pathname) return;
    if (from !== null) {
      void routerHooks.onRouteLeave.emit({ path: from });
      void routerHooks.onNavigate.emit({ path: pathname, from });
    }
    void routerHooks.onRouteEnter.emit({ path: pathname });
    prevPathnameRef.current = pathname;
  }, [pathname]);

  // onAppReady: once per page load, when the user is signed in and the
  // plugins have been started, so every plugin enabled at start hears it.
  const pluginsReady = usePluginStore((s) => s.initialized);
  const signedIn = useAuthStore((s) => s.isAuthenticated);

  // Start the plugins on whichever page the user lands on. They used to start
  // only from the mail view, so a plugin's sidebar entry, page or reminders
  // were missing on Calendar, Contacts, Files or Settings opened directly.
  // Server themes had the same problem: one installed by the admin never
  // reached the theme picker until the mail view had been opened.
  useEffect(() => {
    if (!signedIn) return;
    void usePluginStore.getState().initializePlugins();
    void useThemeStore.getState().syncServerThemes();
  }, [signedIn]);

  // A start that hit a 401 before the session was renewed (a tab that slept
  // past its token) gave up; the renewed token starts it again (#1895).
  const tokenExpiresAt = useAuthStore((s) => s.tokenExpiresAt);
  useEffect(() => {
    if (!signedIn || !tokenExpiresAt || usePluginStore.getState().initialized) return;
    void usePluginStore.getState().initializePlugins();
  }, [signedIn, tokenExpiresAt]);

  const readyFired = useRef(false);
  useEffect(() => {
    if (readyFired.current || !pluginsReady || !signedIn) return;
    readyFired.current = true;
    void appLifecycleHooks.onAppReady.emit({ accountId: useAccountStore.getState().activeAccountId });
  }, [pluginsReady, signedIn]);

  return null;
}
