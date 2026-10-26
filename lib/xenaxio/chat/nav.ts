// Step 43, part B: the "Chat" entry of the navigation (rail, Mountain View top
// bar, phone bar): shown when the company's chat is on; the unread badge
// comes from the chat connection, opened in the background once per page load.
import { useEffect } from "react";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { useChatStore } from "./store";

/** Background connection starts a moment after the page, so mail loads first. */
const CONNECT_DELAY_MS = 3000;

export function useChatNavItem(): { visible: boolean; label: string; badge: number } {
  const t = useXT();
  const enabled = useChatStore((s) => !!s.status?.enabled);
  const client = useChatStore((s) => s.client);
  useChatStore((s) => s.version);
  const loadStatus = useChatStore((s) => s.loadStatus);
  const connect = useChatStore((s) => s.connect);

  useEffect(() => {
    if (!XENAXIO_BFF) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadStatus().then((status) => {
      if (status?.enabled) timer = setTimeout(() => void connect(), CONNECT_DELAY_MS);
    });
    return () => clearTimeout(timer);
  }, [loadStatus, connect]);

  const totals = client?.ready ? client.totals() : { notifications: 0, highlights: 0 };
  // Like Slack: direct messages and mentions count; ordinary channel messages only make the channel bold.
  let badge = totals.highlights;
  if (client?.ready) for (const room of client.rooms.values()) if (room.kind === "dm" && room.membership === "join") badge += room.notifications - room.highlights;
  return { visible: XENAXIO_BFF && enabled, label: t("chat.nav"), badge: Math.max(0, badge) };
}
