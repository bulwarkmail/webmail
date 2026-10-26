"use client";

// Step 43, part B: a scrolling timeline. Sticks to the bottom while new
// messages come in (unless the reader scrolled up), loads older ones at the
// top, jumps to a message on request, marks read when the end is seen.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatClient, Message, Room } from "@/lib/xenaxio/chat/client";
import { timelineRows } from "@/lib/xenaxio/chat/view";
import { useXT } from "@/lib/xenaxio/i18n";
import { useChatTime } from "./common";
import { ChatMessage } from "./message";

export function MessageList({
  room,
  client,
  messages,
  inThread,
  threadRoot,
  focusId,
  header,
}: {
  room: Room;
  client: ChatClient;
  messages: Message[];
  inThread?: boolean;
  threadRoot?: string;
  focusId?: string | null;
  header?: React.ReactNode;
}) {
  const t = useXT();
  const { day } = useChatTime();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const lastCount = useRef(0);
  const restore = useRef<number | null>(null);

  // The "new" line stays where it was when the channel was opened.
  const readMark = useRef<{ room: string; readUpTo: string | null; unread: boolean } | null>(null);
  if (!inThread && readMark.current?.room !== room.id) readMark.current = { room: room.id, readUpTo: room.readUpTo, unread: room.notifications > 0 };

  const rows = useMemo(
    () => timelineRows(messages, inThread ? {} : { readUpTo: readMark.current?.readUpTo, me: client.userId, hasUnread: readMark.current?.unread }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messages are mutated in place; length and last id tell changes
    [messages, messages.length, messages[messages.length - 1]?.id, inThread, client.userId, room.id],
  );

  const markRead = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void client.markRead(room.id, threadRoot);
  };

  // New messages: stay at the bottom if we were there; older ones loaded: keep the view still.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current !== null) {
      el.scrollTop = el.scrollHeight - restore.current;
      restore.current = null;
    } else if (atBottom.current || lastCount.current === 0) {
      el.scrollTop = el.scrollHeight;
    }
    lastCount.current = messages.length;
    if (atBottom.current) markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on every new row
  }, [rows.length, messages[messages.length - 1]?.id]);

  // Opening another channel or thread: start at the bottom.
  useEffect(() => {
    atBottom.current = true;
    lastCount.current = 0;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on switching
  }, [room.id, threadRoot]);

  // Too few messages to scroll (e.g. right after joining): load older ones
  // until the view is filled or the history begins.
  useEffect(() => {
    const el = scroller.current;
    if (!el || inThread || room.atStart || loading) return;
    if (el.scrollHeight > el.clientHeight + 200) return;
    setLoading(true);
    void client
      .loadOlder(room.id)
      .catch(() => undefined)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-checked whenever rows change
  }, [room.id, rows.length, room.atStart, room.prevBatch]);

  // Jump to a message (search result, link, saved item), loading older ones until it is there.
  useEffect(() => {
    if (!focusId) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 20 && !cancelled; i++) {
        const el = document.getElementById(`msg-${focusId}`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          atBottom.current = false;
          setHighlight(focusId);
          setTimeout(() => setHighlight(null), 2500);
          return;
        }
        if (inThread || room.atStart) return;
        await client.loadOlder(room.id).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusId, room.id, client, inThread, room.atStart]);

  // Come back to the tab at the bottom: what is shown is now read.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && atBottom.current) markRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRead reads current props
  }, [room.id, threadRoot]);

  const onScroll = async () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (bottom && !atBottom.current) markRead();
    atBottom.current = bottom;
    if (!inThread && el.scrollTop < 200 && !loading && !room.atStart) {
      setLoading(true);
      restore.current = el.scrollHeight - el.scrollTop;
      try {
        await client.loadOlder(room.id);
      } catch {
        restore.current = null;
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div ref={scroller} onScroll={() => void onScroll()} className="flex-1 min-h-0 overflow-y-auto overscroll-contain" role="log" aria-live="polite">
      <div className="flex min-h-full flex-col justify-end pb-2">
        {!inThread && room.atStart && header}
        {!inThread && !room.atStart && (
          <div className="py-3 text-center text-xs text-muted-foreground">{loading ? t("chat.loading") : ""}</div>
        )}
        {inThread && header}
        {rows.map((row) => {
          if (row.kind === "day")
            return (
              <div key={row.key} className="relative my-2 flex items-center px-5" role="separator">
                <div className="h-px flex-1 bg-border" />
                <span className="mx-2 rounded-full border border-border bg-background px-3 py-0.5 text-xs font-medium">{day(row.day)}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            );
          if (row.kind === "new")
            return (
              <div key={row.key} className="my-1 flex items-center px-5" role="separator">
                <div className="h-px flex-1 bg-red-500/70" />
                <span className="ml-2 text-[11px] font-semibold uppercase text-red-500">{t("chat.new_line")}</span>
              </div>
            );
          return <ChatMessage key={row.key} message={row.message} room={room} client={client} continued={row.continued} inThread={inThread} highlighted={highlight === row.message.id} />;
        })}
      </div>
    </div>
  );
}
