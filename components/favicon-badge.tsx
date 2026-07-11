"use client";

import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useFaviconBadge } from "@/hooks/use-favicon-badge";

/**
 * Badges the browser-tab favicon with the inbox unread count, so new mail is
 * visible without focusing the tab. See issue #560.
 *
 * Opt-out via the `faviconUnreadBadge` setting (Settings -> Appearance); on by
 * default.
 *
 * Mounted in the root layout rather than on the mail route: the badge belongs
 * to the tab, not to a page. Mounting it on the mail page unmounted it — and so
 * cleared the badge, and flickered the icon — on every hop to /settings,
 * /calendar or /contacts.
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

  return null;
}
