"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp } from "@/components/icons";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { cn } from "@/lib/utils";

/**
 * Below this reading-pane height a docked reply can't share the pane with
 * the message: an 800×600 window or a 1366×768 laptop at 150 % left two
 * lines to type in and none of the message (compose-p2-4).
 */
export const DOCK_SHARE_MIN_PANE = 700;
/** Lines of the message's text, at least, above a docked reply (about five). */
export const DOCK_MIN_BODY_SHOWN = 100;
/**
 * The lowest a reply sharing the pane gets: To, the bottom bar and about
 * eight lines to type in. Lower, and it takes the pane instead.
 */
export const DOCK_MIN_HEIGHT = 320;
/** The share of the pane a reply starts with until the user drags the divider. */
export const DOCK_DEFAULT_SHARE = 0.6;
/** What stays of the message above a reply the user dragged up: its sender line at least. */
export const DOCK_MIN_MESSAGE = 80;
const SHARE_KEY = "replyDockShare";

/**
 * How the reply docked under its message takes the reading pane
 * (mail-p2-2, compose-p2-4, inline-reply).
 *
 * - A tall pane: the reply gets a fixed share of it, 60 % until the user
 *   drags the divider above it, and at least DOCK_MIN_HEIGHT. The message
 *   scrolls above it. It used to start as low as its fields and grow with
 *   the text, which left a line or two to type in.
 * - A short pane, or a plugin panel open beside the reply: the reply takes
 *   the pane under the reader's toolbar, with the message folded to a bar
 *   ("Show the message") that unfolds it, and back.
 */
export function dockLayout({
  paneHeight,
  readerChrome = 0,
  aboveBody = 0,
  share = null,
  wantsRoom = false,
}: {
  paneHeight: number;
  /** The reader's toolbar and subject, above its scrolling part. */
  readerChrome?: number;
  /** Above the message's text: the reader's toolbar and subject, the sender, the attachment cards. */
  aboveBody?: number;
  /** The share of the pane the user dragged the reply to; null until they do. */
  share?: number | null;
  /** Something in the reply needs the room (a plugin panel beside it). */
  wantsRoom?: boolean;
}): { mode: 'share' | 'takeover'; height?: number } {
  if (wantsRoom) return { mode: 'takeover' };
  if (paneHeight <= 0) return { mode: 'share' };
  if (paneHeight < DOCK_SHARE_MIN_PANE) return { mode: 'takeover' };
  const most = paneHeight - readerChrome - DOCK_MIN_MESSAGE;
  if (most < DOCK_MIN_HEIGHT) return { mode: 'takeover' };
  let height = Math.round(paneHeight * (share ?? DOCK_DEFAULT_SHARE));
  // Until the user picks a size, some of the message's text stays above the
  // reply: attachment cards took all of it at 1366×768 and 125 % (compose-p3-7).
  // For that the reply gives up its share down to half the pane, no further.
  if (share == null && aboveBody > 0) {
    height = Math.min(height, Math.max(Math.round(paneHeight / 2), paneHeight - aboveBody - DOCK_MIN_BODY_SHOWN));
  }
  return { mode: 'share', height: Math.max(DOCK_MIN_HEIGHT, Math.min(most, height)) };
}

function readShare(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const n = parseFloat(localStorage.getItem(SHARE_KEY) ?? "");
    return Number.isFinite(n) && n > 0.1 && n < 0.95 ? n : null;
  } catch { return null; }
}

function writeShare(share: number | null) {
  try {
    if (share == null) localStorage.removeItem(SHARE_KEY);
    else localStorage.setItem(SHARE_KEY, share.toFixed(3));
  } catch { /* storage blocked */ }
}

interface ReplyDockApi {
  /** The composer asks for the whole pane while it shows a plugin panel, and gives it back. */
  setWantsRoom: (wants: boolean) => void;
}

const ReplyDockContext = createContext<ReplyDockApi | null>(null);

/** The dock the composer sits in, or null outside one. */
export function useReplyDock(): ReplyDockApi | null {
  return useContext(ReplyDockContext);
}

export function ReplyDock({ children }: { children: ReactNode }) {
  const t = useTranslations("mail_p2_conv");
  const tDock = useTranslations("compose_dock");
  const ref = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState(0);
  // The reader's toolbar and subject above its scrolling part: they stay.
  const [readerChrome, setReaderChrome] = useState(0);
  // The reader's toolbar alone: a reply that takes the pane covers the subject too.
  const [readerToolbar, setReaderToolbar] = useState(0);
  // What comes before the message's text in the scrolling part: the sender, the attachment cards.
  const [beforeBody, setBeforeBody] = useState(0);
  const [subject, setSubject] = useState("");
  const [showMessage, setShowMessage] = useState(false);
  const [wantsRoom, setWantsRoomState] = useState(false);
  const [share, setShare] = useState<number | null>(readShare);
  // The latest share, for the end of a drag to keep.
  const shareRef = useRef(share);
  const dragStart = useRef(0);

  useLayoutEffect(() => {
    const pane = ref.current?.parentElement;
    if (!pane) return;
    const scroll = pane.querySelector<HTMLElement>("[data-reader-scroll]");
    const body = scroll?.querySelector<HTMLElement>("[data-reader-body]") ?? null;
    const subjectBlock = pane.querySelector<HTMLElement>("[data-reader-subject]");
    const measure = () => {
      const paneBox = pane.getBoundingClientRect();
      setPaneHeight(Math.round(paneBox.height));
      const scrollTop = scroll ? scroll.getBoundingClientRect().top : paneBox.top;
      const chrome = scroll ? Math.max(0, Math.round(scrollTop - paneBox.top)) : 0;
      setReaderChrome(chrome);
      // Only a subject under a toolbar: with the toolbar below the subject, the toolbar stays.
      const subjectTop = subjectBlock ? Math.round(subjectBlock.getBoundingClientRect().top - paneBox.top) : 0;
      setReaderToolbar(subjectTop > 0 && subjectTop <= chrome ? subjectTop : chrome);
      setBeforeBody(scroll && body ? Math.max(0, Math.round(body.getBoundingClientRect().top - scrollTop + scroll.scrollTop)) : 0);
      setSubject(subjectBlock?.querySelector("h2")?.textContent?.trim() ?? "");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    // The attachment cards and the sender load after the dock opens.
    if (scroll?.firstElementChild) ro.observe(scroll.firstElementChild);
    return () => ro.disconnect();
  }, []);

  const setWantsRoom = useCallback((wants: boolean) => setWantsRoomState(wants), []);
  const api = useMemo<ReplyDockApi>(() => ({ setWantsRoom }), [setWantsRoom]);

  const layout = dockLayout({
    paneHeight,
    readerChrome,
    aboveBody: beforeBody > 0 ? readerChrome + beforeBody : 0,
    share,
    wantsRoom,
  });
  const takeover = layout.mode === "takeover";
  const folded = takeover && showMessage;
  const top = takeover ? readerToolbar : readerChrome;
  const most = Math.max(DOCK_MIN_HEIGHT, paneHeight - readerChrome - DOCK_MIN_MESSAGE);

  return (
    <ReplyDockContext.Provider value={api}>
      <div
        ref={ref}
        data-reply-dock=""
        data-dock-mode={layout.mode}
        className="relative flex min-h-0 shrink-0 flex-col border-t border-border bg-background"
        style={takeover
          ? (folded ? undefined : { height: Math.max(paneHeight - top, 0) })
          : (layout.height ? { height: layout.height } : { height: `${DOCK_DEFAULT_SHARE * 100}%` })}
      >
        {/* The divider above a reply that shares the pane: drag it, or use the arrow keys. */}
        {!takeover && paneHeight > 0 && (
          <ResizeHandle
            orientation="horizontal"
            testId="reply-dock-resize"
            label={tDock("resize_reply")}
            value={layout.height}
            min={DOCK_MIN_HEIGHT}
            max={most}
            className="absolute inset-x-0 top-0 my-0 -translate-y-1/2 bg-transparent"
            onResizeStart={() => { dragStart.current = layout.height ?? 0; }}
            onResize={(delta) => {
              const next = Math.max(DOCK_MIN_HEIGHT, Math.min(most, dragStart.current - delta));
              shareRef.current = next / paneHeight;
              setShare(shareRef.current);
            }}
            onResizeEnd={() => writeShare(shareRef.current)}
            onDoubleClick={() => { shareRef.current = null; setShare(null); writeShare(null); }}
          />
        )}
        {takeover && (
          <button
            type="button"
            onClick={() => setShowMessage((v) => !v)}
            aria-expanded={showMessage}
            data-dock-show-message=""
            className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            {showMessage ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronUp className="h-4 w-4 shrink-0" />}
            <span className="shrink-0">{showMessage ? t("back_to_reply") : t("show_message")}</span>
            {/* The subject the reply covers, so it stays in sight. */}
            {!showMessage && subject && (
              <span dir="auto" className="min-w-0 truncate text-foreground" data-dock-subject="">{subject}</span>
            )}
          </button>
        )}
        {/* Folded, the composer stays mounted, with its text and its undo history. */}
        <div className={cn("flex min-h-0 flex-1 flex-col", folded && "hidden")}>
          {children}
        </div>
      </div>
    </ReplyDockContext.Provider>
  );
}
