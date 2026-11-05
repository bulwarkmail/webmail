"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isDesktopApp } from "@/lib/desktop/bridge";

/**
 * The page-wide hosts the first screen doesn't need, out of the first script.
 *
 * Each is its own chunk. The desktop app's hosts load only in the desktop app:
 * a browser has no bridge for them to talk to, so it never fetches them. The
 * others load once the page has drawn and the browser is idle: what they do
 * (an import or export running in the background, offline mode, pop-out
 * windows, dropped files, notification buttons) can't be asked for before
 * then, and on a cold start their code held up the sign-in form and the
 * first rows.
 */

const DesktopOsHost = dynamic(() => import("@/components/desktop/desktop-os-host").then((m) => m.DesktopOsHost), { ssr: false });
const EditedFilesHost = dynamic(() => import("@/components/desktop/edited-files-host").then((m) => m.EditedFilesHost), { ssr: false });
const FilesSyncHost = dynamic(() => import("@/components/providers/files-sync-host").then((m) => m.FilesSyncHost), { ssr: false });
const FilesSyncPrompts = dynamic(() => import("@/components/files-sync/files-sync-prompts").then((m) => m.FilesSyncPrompts), { ssr: false });
const WindowMenuBar = dynamic(() => import("@/components/layout/window-menu-bar").then((m) => m.WindowMenuBar), { ssr: false });
const DesktopHost = dynamic(() => import("@/components/desktop/desktop-host").then((m) => m.DesktopHost), { ssr: false });

const MailTransferHost = dynamic(() => import("@/components/mail-transfer/mail-transfer-host").then((m) => m.MailTransferHost), { ssr: false });
const OfflineHost = dynamic(() => import("@/components/offline/offline-host").then((m) => m.OfflineHost), { ssr: false });
const PopoutHost = dynamic(() => import("@/components/popout/popout-host").then((m) => m.PopoutHost), { ssr: false });
const FileDropHost = dynamic(() => import("@/components/file-drop/file-drop-host").then((m) => m.FileDropHost), { ssr: false });
const NotificationActionsHost = dynamic(() => import("@/components/providers/notification-actions-host").then((m) => m.NotificationActionsHost), { ssr: false });

/** Renders its children only in the desktop app, after hydration. */
function DesktopOnly({ children }: { children: React.ReactNode }) {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(isDesktopApp()), []);
  return desktop ? <>{children}</> : null;
}

// One idle wait for every deferred host on the page.
let booted = false;
const bootListeners = new Set<() => void>();
let bootScheduled = false;
const IDLE_TIMEOUT_MS = 2_000;

function scheduleBoot(): void {
  if (bootScheduled || typeof window === "undefined") return;
  bootScheduled = true;
  const done = () => {
    booted = true;
    for (const listener of bootListeners) listener();
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(done, { timeout: IDLE_TIMEOUT_MS });
  else window.setTimeout(done, 200);
}

function subscribeBoot(listener: () => void): () => void {
  bootListeners.add(listener);
  scheduleBoot();
  return () => { bootListeners.delete(listener); };
}

/** Whether the page has drawn and gone idle once since it loaded. */
export function useAfterBoot(): boolean {
  return useSyncExternalStore(subscribeBoot, () => booted, () => false);
}

/** Renders its children once the page has drawn and gone idle. */
function AfterBoot({ children }: { children: React.ReactNode }) {
  return useAfterBoot() ? <>{children}</> : null;
}

export function DeferredDesktopOsHost() { return <DesktopOnly><DesktopOsHost /></DesktopOnly>; }
export function DeferredEditedFilesHost() { return <DesktopOnly><EditedFilesHost /></DesktopOnly>; }
export function DeferredFilesSyncHost() { return <DesktopOnly><FilesSyncHost /></DesktopOnly>; }
export function DeferredFilesSyncPrompts() { return <DesktopOnly><FilesSyncPrompts /></DesktopOnly>; }
export function DeferredWindowMenuBar() { return <DesktopOnly><WindowMenuBar /></DesktopOnly>; }
export function DeferredDesktopHost() { return <DesktopOnly><DesktopHost /></DesktopOnly>; }

export function DeferredMailTransferHost() { return <AfterBoot><MailTransferHost /></AfterBoot>; }
export function DeferredOfflineHost() { return <AfterBoot><OfflineHost /></AfterBoot>; }
export function DeferredPopoutHost() { return <AfterBoot><PopoutHost /></AfterBoot>; }
export function DeferredFileDropHost() { return <AfterBoot><FileDropHost /></AfterBoot>; }
export function DeferredNotificationActionsHost() { return <AfterBoot><NotificationActionsHost /></AfterBoot>; }
