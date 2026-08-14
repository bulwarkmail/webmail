"use client";

import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useFaviconBadge } from "@/hooks/use-favicon-badge";
import { useAppBadge } from "@/hooks/use-app-badge";

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
  // The store's canonical inbox selector. `role === 'inbox'` alone is not
  // enough: shared and group inboxes ship in the same `mailboxes` array, so on
  // a delegated setup the first match can be somebody else's inbox.
  const inboxUnread = useEmailStore(
    (s) => s.mailboxes.find((m) => m.role === "inbox" && !m.isShared)?.unreadEmails ?? 0,
  );
  const enabled = useSettingsStore((s) => s.faviconUnreadBadge);

  useFaviconBadge(inboxUnread, enabled);
  useAppBadge(inboxUnread, enabled);

  return null;
}
