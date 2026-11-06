"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isDesktopApp } from "@/lib/desktop/bridge";
import { LEGACY_DB_NAME } from "@/lib/offline/legacy-db-name";
import { OFFLINE_EVICTED_KEY, useOfflineStore } from "@/lib/offline/state";
import { STORE_DB_NAME, STORE_OPENED_KEY } from "@/lib/store/client/keys";
import { HostBoundary } from "@/components/providers/host-boundary";

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
 *
 * Each sits in a boundary of its own: one that fails stops by itself, logs
 * why and shows nothing, and the rest of the app goes on.
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
function DesktopOnly({ name, children }: { name: string; children: React.ReactNode }) {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(isDesktopApp()), []);
  return desktop ? <HostBoundary name={name}>{children}</HostBoundary> : null;
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
function AfterBoot({ name, children }: { name: string; children: React.ReactNode }) {
  return useAfterBoot() ? <HostBoundary name={name}>{children}</HostBoundary> : null;
}

export function DeferredDesktopOsHost() { return <DesktopOnly name="DesktopOsHost"><DesktopOsHost /></DesktopOnly>; }
export function DeferredEditedFilesHost() { return <DesktopOnly name="EditedFilesHost"><EditedFilesHost /></DesktopOnly>; }
export function DeferredFilesSyncHost() { return <DesktopOnly name="FilesSyncHost"><FilesSyncHost /></DesktopOnly>; }
export function DeferredFilesSyncPrompts() { return <DesktopOnly name="FilesSyncPrompts"><FilesSyncPrompts /></DesktopOnly>; }
export function DeferredWindowMenuBar() { return <DesktopOnly name="WindowMenuBar"><WindowMenuBar /></DesktopOnly>; }
export function DeferredDesktopHost() { return <DesktopOnly name="DesktopHost"><DesktopHost /></DesktopOnly>; }

export function DeferredMailTransferHost() { return <AfterBoot name="MailTransferHost"><MailTransferHost /></AfterBoot>; }
/** Something stored says offline mode has been used here (or the desktop app, where it's on by default). */
function offlineUsedHere(): boolean {
  if (isDesktopApp()) return true;
  const s = useOfflineStore.getState();
  if (s.enabled.length > 0 || Object.keys(s.choices).length > 0 || Object.keys(s.health).length > 0) return true;
  try {
    return localStorage.getItem(STORE_OPENED_KEY) !== null || localStorage.getItem(OFFLINE_EVICTED_KEY) !== null;
  } catch {
    return true;
  }
}

/**
 * Whether offline mode is in use in this browser: turned on for an account, or
 * data kept from it (the store, or an outbox from before the store). Turning it
 * on, here or in another tab, starts it.
 */
function useOfflineInUse(): boolean {
  const [inUse, setInUse] = useState(false);
  useEffect(() => {
    if (offlineUsedHere()) { setInUse(true); return; }
    let done = false;
    const now = () => { if (!done) { done = true; setInUse(true); } };
    const off = useOfflineStore.subscribe(() => { if (offlineUsedHere()) now(); });
    const onStorage = () => { if (offlineUsedHere()) now(); };
    window.addEventListener("storage", onStorage);
    // A database left from an earlier start; a browser that can't list them may have one.
    const listing = typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function" ? indexedDB.databases() : null;
    if (listing) listing.then((dbs) => { if (dbs.some((db) => db.name === STORE_DB_NAME || db.name === LEGACY_DB_NAME)) now(); }, now);
    else if (typeof indexedDB !== "undefined") now();
    return () => { done = true; off(); window.removeEventListener("storage", onStorage); };
  }, []);
  return inUse;
}

function OfflineWhenUsed() {
  return useOfflineInUse() ? <OfflineHost /> : null;
}

export function DeferredOfflineHost() { return <AfterBoot name="OfflineHost"><OfflineWhenUsed /></AfterBoot>; }
export function DeferredPopoutHost() { return <AfterBoot name="PopoutHost"><PopoutHost /></AfterBoot>; }
export function DeferredFileDropHost() { return <AfterBoot name="FileDropHost"><FileDropHost /></AfterBoot>; }
export function DeferredNotificationActionsHost() { return <AfterBoot name="NotificationActionsHost"><NotificationActionsHost /></AfterBoot>; }
