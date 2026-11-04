"use client";

import { useSettingsStore } from "@/stores/settings-store";
import { useFaviconBadge } from "@/hooks/use-favicon-badge";
import { useAppBadge } from "@/hooks/use-app-badge";
import { useAllInboxesUnread } from "@/hooks/use-all-inboxes-unread";

/**
 * Badges the browser-tab favicon, and — where supported — the installed PWA's
 * app icon, with the inbox unread count, so new mail is visible without
 * focusing the tab. See issue #560.
 *
 * Two independent mechanisms share the one unread count: `useFaviconBadge`
 * repaints the in-tab favicon (works everywhere); `useAppBadge` calls the
 * Badging API for the separate icon Chrome/Edge pin next to the address bar
 * once the app is installed — Chromium supports it there, WebKit supports it
 * for an iOS/iPadOS Home Screen web app; a silent no-op anywhere else.
 *
 * Both opt out via the single `faviconUnreadBadge` setting (Settings ->
 * Appearance); on by default.
 *
 * Mounted in the root layout rather than on the mail route: the badge belongs
 * to the tab/app, not to a page. Mounting it on the mail page unmounted it —
 * and so cleared the badge, and flickered the icon — on every hop to
 * /settings, /calendar or /contacts.
 *
 * Renders nothing.
 */
export function FaviconBadge() {
  const enabled = useSettingsStore((s) => s.faviconUnreadBadge);
  // With several accounts the badge counts the inbox of each (on by default):
  // new mail in an account that is not on screen still shows on the icon and
  // in the desktop tray.
  const count = useAllInboxesUnread();

  useFaviconBadge(count, enabled);
  useAppBadge(count, enabled);

  return null;
}
