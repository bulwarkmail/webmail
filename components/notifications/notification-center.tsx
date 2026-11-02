"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFormatter, useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, Bell, CheckCheck, ExternalLink, Puzzle, Trash2, X } from "@/components/icons";
import { useConfig } from "@/hooks/use-config";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { isDocumentRTL } from "@/i18n/direction";
import { toastHooks } from "@/lib/plugin-hooks";
import { gateLinkClick } from "@/lib/plugin-hook-result";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  selectUnreadCount,
  useNotificationCenterStore,
  type CenterEntry,
} from "@/stores/notification-center-store";

/** "99+" past two digits, like the other badges. */
export function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function useUnreadNotificationCount(): number {
  return useNotificationCenterStore(selectUnreadCount);
}

function EntryIcon({ entry }: { entry: CenterEntry }) {
  if (entry.level === "error") return <AlertCircle className="w-4 h-4 text-destructive" />;
  if (entry.level === "warning") return <AlertTriangle className="w-4 h-4 text-warning" />;
  if (entry.pluginId) return <Puzzle className="w-4 h-4 text-muted-foreground" />;
  return <Bell className="w-4 h-4 text-muted-foreground" />;
}

/**
 * The list behind the bell: recent notifications from plugins and the app's
 * error and warning toasts, newest first. Clicking a plugin's entry tells
 * that plugin (onNotificationClick), as a click on the system notification
 * does.
 */
export function NotificationPanel({ onClose, className, sheet = false }: { onClose: () => void; className?: string; sheet?: boolean }) {
  const t = useTranslations("notification_center");
  const format = useFormatter();
  const { appName } = useConfig();
  const entries = useNotificationCenterStore((s) => s.entries);
  const unread = useNotificationCenterStore(selectUnreadCount);
  const markRead = useNotificationCenterStore((s) => s.markRead);
  const markAllRead = useNotificationCenterStore((s) => s.markAllRead);
  const clear = useNotificationCenterStore((s) => s.clear);
  const [now] = useState(() => Date.now());

  const openEntry = (entry: CenterEntry) => {
    markRead(entry.id);
    if (!entry.pluginId) return;
    onClose();
    void toastHooks.onNotificationClick.emitTo(entry.pluginId, { tag: entry.tag ?? "" });
  };

  return (
    <div className={cn("flex flex-col bg-background text-foreground", className)} data-notification-panel="">
      <div className="flex items-center gap-1 px-3 h-12 border-b border-border shrink-0">
        {/* Full screen on a phone it is a dialog of its own, titled like one. */}
        <h2 className={cn("flex-1 min-w-0 truncate font-semibold", sheet ? "text-lg" : "text-sm")}>{t("title")}</h2>
        <Button variant="ghost" size="xs" onClick={markAllRead} disabled={unread === 0} className="gap-1 px-2 text-xs text-muted-foreground">
          <CheckCheck className="w-4 h-4" />
          <span>{t("mark_all_read")}</span>
        </Button>
        <Button variant="ghost" size="xs" onClick={clear} disabled={entries.length === 0} className="gap-1 px-2 text-xs text-muted-foreground">
          <Trash2 className="w-4 h-4" />
          <span>{t("clear")}</span>
        </Button>
        {sheet && (
          <IconButton size="icon-lg" label={t("close")} title="" onClick={onClose} className="text-muted-foreground">
            <X />
          </IconButton>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto py-1" aria-label={t("title")}>
          {entries.map((entry) => {
            const source = entry.pluginName ?? appName;
            const content = (
              <>
                <span className="mt-0.5 flex-shrink-0" aria-hidden="true"><EntryIcon entry={entry} /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className={cn("flex-1 min-w-0 truncate text-sm", !entry.read && "font-semibold")}>{entry.title}</span>
                    <time dateTime={new Date(entry.time).toISOString()} className="flex-shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
                      {format.relativeTime(new Date(entry.time), now)}
                    </time>
                  </span>
                  {entry.body && <span className="block text-xs text-muted-foreground line-clamp-2 break-words">{entry.body}</span>}
                  <span className="block text-[0.6875rem] text-muted-foreground truncate">
                    {entry.level !== "info" && <span className="sr-only">{t(entry.level === "error" ? "level_error" : "level_warning")}: </span>}
                    {source}
                  </span>
                </span>
                {!entry.read && (
                  <span className="mt-1.5 w-2 h-2 rounded-full bg-primary flex-shrink-0" aria-label={t("unread")} />
                )}
              </>
            );
            return (
              <li key={entry.id} data-entry-source={entry.pluginId ?? "app"}>
                {entry.pluginId ? (
                  <button
                    type="button"
                    onClick={() => openEntry(entry)}
                    className="w-full flex items-start gap-2.5 px-3 py-2 text-start hover:bg-muted focus-visible:bg-muted focus-visible:outline-none transition-colors"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-start gap-2.5 px-3 py-2">
                    {content}
                  </div>
                )}
                {entry.action && (
                  // Lined up with the text above (padding + icon + gap). A link of
                  // its own, outside the entry's button: one control can't hold another.
                  <a
                    href={entry.action.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => { markRead(entry.id); gateLinkClick(event); }}
                    onAuxClick={(event) => { markRead(entry.id); gateLinkClick(event); }}
                    className="-mt-1 mb-1 ms-[38px] inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-hidden"
                  >
                    {entry.action.label}
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The panel's enabled controls, in tab order. */
function panelControls(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]"));
}

/** The phone version: the panel over the whole screen. */
export function NotificationSheet({ onClose }: { onClose: () => void }) {
  const t = useTranslations("notification_center");
  const ref = useFocusTrap({ isActive: true, onEscape: onClose, restoreFocus: true });
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t("title")}
      className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)]"
    >
      <NotificationPanel onClose={onClose} sheet className="flex-1 min-h-0" />
    </div>,
    document.body,
  );
}

/**
 * The bell with the unread count. `side` opens the panel beside the button
 * (navigation rail), `below` drops it under the button (Mountain View's top
 * bar).
 */
export function NotificationBell({ placement, className }: { placement: "side" | "below"; className?: string }) {
  const t = useTranslations("notification_center");
  const unread = useUnreadNotificationCount();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const close = useCallback(() => setOpen(false), []);

  const position = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (placement === "side") {
      const bottom = Math.max(8, window.innerHeight - rect.bottom);
      setStyle(isDocumentRTL()
        ? { position: "fixed", right: window.innerWidth - rect.left + 8, bottom }
        : { position: "fixed", left: rect.right + 8, bottom });
    } else {
      const top = rect.bottom + 4;
      setStyle(isDocumentRTL()
        ? { position: "fixed", left: Math.max(8, rect.left), top }
        : { position: "fixed", right: Math.max(8, window.innerWidth - rect.right), top });
    }
  }, [placement]);

  useLayoutEffect(() => {
    if (open) position();
  }, [open, position]);

  // The panel is portalled to the end of <body>, so Tab from the bell would
  // never reach it: focus moves in on open, to its first control (or the
  // panel itself while every control is disabled).
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    (panelControls(panel)[0] ?? panel).focus();
  }, [open]);

  // Tab past either end of the panel closes it and goes back to the bell, so
  // the next Tab carries on from where the panel was opened.
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const controls = panelControls(panelRef.current);
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    const leaving = controls.length === 0
      || (e.shiftKey ? active === first || active === panelRef.current : active === last);
    if (!leaving) return;
    e.preventDefault();
    setOpen(false);
    buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (buttonRef.current?.contains(e.target as Node) || panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", position);
    };
  }, [open, position]);

  const label = unread > 0 ? `${t("title")} (${t("unread_count", { count: unread })})` : t("title");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative grid place-items-center transition-colors",
          open ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
        title={t("title")}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-notification-bell=""
      >
        <Bell className={placement === "side" ? "w-[18px] h-[18px]" : "w-5 h-5"} />
        {unread > 0 && (
          <span
            className={cn(
              "absolute flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[0.625rem] font-bold",
              placement === "side" ? "-top-0.5 -end-0.5" : "top-1.5 end-1.5",
            )}
            aria-hidden="true"
          >
            {formatBadgeCount(unread)}
          </span>
        )}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("title")}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          style={style}
          className="z-50 w-[22rem] max-w-[calc(100vw-1rem)] max-h-[min(32rem,80vh)] flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        >
          <NotificationPanel onClose={close} className="flex-1 min-h-0" />
        </div>,
        document.body,
      )}
    </>
  );
}
