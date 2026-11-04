"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef, useId } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { X, CheckCircle, AlertCircle, Info, AlertTriangle, Loader2 } from "@/components/icons";
import { cn } from "@/lib/utils";
import { TOUCH_HIT_AREA } from "@/components/ui/button";
import { useContextMenuOpen } from "@/components/ui/context-menu";
import { useMediaQuery, narrowerThan } from "@/hooks/use-media-query";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  onClick?: () => void;
  /**
   * Called when the user closes the toast: the close button, a click on the
   * toast or on one of its actions. Not called when it times out.
   */
  onDismiss?: () => void;
  icon?: React.ReactNode;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  /**
   * A third action. Three buttons do not fit beside the text, so a toast
   * that has one lays its actions out on a row of their own.
   */
  tertiaryAction?: ToastAction;
  /** More actions at the end of that row. Needs a tertiaryAction. */
  extraActions?: ToastAction[];
  /**
   * Work in progress, e.g. an upload: 0..1, or null while the amount is
   * unknown. The bottom line then shows progress instead of a countdown,
   * and the toast stays until it is updated or removed.
   */
  progress?: number | null;
  /**
   * Hovering pauses the countdown so a toast can be read. Off for a toast
   * whose action stops working at a fixed time, like Undo send: there the
   * countdown has to match the time that is left.
   */
  pauseOnHover?: boolean;
  /**
   * Read out after the title and message but not shown, e.g. "Press Ctrl+Z
   * to undo." for a toast whose Undo has a shortcut.
   */
  srHint?: string;
}

interface ToastProps {
  toast: Toast;
  onClose: (id: string) => void;
  /** Kept out of sight for now (a menu is open over it): the countdown waits. */
  held?: boolean;
  /** The toast goes away with the keyboard focus in it: put the focus back. */
  onFocusLost?: () => void;
}

/**
 * Jumps to the newest toast from anywhere (Alt+Shift+N), so its Undo can be
 * reached without tabbing through the page. Listed in lib/keyboard-shortcuts.
 */
export function isFocusToastShortcut(e: KeyboardEvent): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyN";
}

/** A modal dialog is open: keys and focus belong to it. */
function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

// Only errors and warnings carry colour; success and info stay neutral
// (repos/branding/APP.md).
const iconStyles = {
  success: "text-muted-foreground",
  error: "text-red-600 dark:text-red-400",
  info: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
};

const progressBarStyles = {
  success: "bg-muted-foreground",
  error: "bg-destructive",
  info: "bg-muted-foreground",
  warning: "bg-warning",
};

// A sideways swipe this far (px) on a touch screen dismisses the toast.
const SWIPE_DISMISS_DISTANCE = 72;

export function ToastItem({ toast, onClose, held = false, onFocusLost }: ToastProps) {
  const tCommon = useTranslations("common");
  const Icon = icons[toast.type];
  const [exiting, setExiting] = useState(false);
  // Swipe to dismiss (touch only): how far it is dragged, and where it flew off to.
  const [dragX, setDragX] = useState(0);
  const [flungTo, setFlungTo] = useState<number | null>(null);
  const swipeRef = useRef<{ id: number; x: number; y: number; horizontal: boolean | null } | null>(null);
  // Swiping holds the countdown; so do the pointer over the toast and the
  // keyboard focus in it (2.2.1), unless the action stops working at a fixed
  // time (pauseOnHover: false).
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const remainingRef = useRef(toast.duration ?? 5000);
  const startRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isProgress = toast.progress !== undefined;

  // A toast updated in place (a finished upload) starts a fresh countdown.
  const lastDurationRef = useRef(toast.duration);
  if (lastDurationRef.current !== toast.duration) {
    lastDurationRef.current = toast.duration;
    remainingRef.current = toast.duration ?? 5000;
  }

  const dismiss = useCallback(() => {
    setExiting(true);
    // Removing the toast would drop the focus onto <body>.
    if (rootRef.current?.contains(document.activeElement)) onFocusLost?.();
    setTimeout(() => onClose(toast.id), 280);
  }, [onClose, toast.id, onFocusLost]);

  const dismissByUser = useCallback(() => {
    try {
      toast.onDismiss?.();
    } catch {
      // A failing listener must not keep the toast on screen.
    }
    dismiss();
  }, [toast, dismiss]);

  const canPause = toast.pauseOnHover !== false;
  const waiting = paused || held || (canPause && (hovered || focused));
  useEffect(() => {
    if (!toast.duration || toast.duration <= 0 || isProgress) return;

    if (waiting) {
      if (timerRef.current) clearTimeout(timerRef.current);
      remainingRef.current = remainingRef.current - (Date.now() - startRef.current);
      return;
    }

    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, remainingRef.current);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.duration, waiting, dismiss, isProgress]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch" || exiting) return;
    swipeRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, horizontal: null };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.id !== e.pointerId) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (swipe.horizontal === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipe.horizontal = Math.abs(dx) > Math.abs(dy);
      if (swipe.horizontal) setPaused(true);
    }
    if (swipe.horizontal) setDragX(dx);
  };
  const endSwipe = (e: React.PointerEvent) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.id !== e.pointerId) return;
    swipeRef.current = null;
    if (!swipe.horizontal) return;
    const dx = e.clientX - swipe.x;
    if (Math.abs(dx) >= SWIPE_DISMISS_DISTANCE) {
      setFlungTo(Math.sign(dx) * window.innerWidth);
      try {
        toast.onDismiss?.();
      } catch {
        // A failing listener must not keep the toast on screen.
      }
      setTimeout(() => onClose(toast.id), 200);
    } else {
      setDragX(0);
      setPaused(false);
    }
  };
  // The click that ends a swipe is not a tap on the toast.
  const swiped = dragX !== 0 || flungTo !== null;

  const actionButton = (action: ToastAction) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        try {
          action.onClick();
          dismissByUser();
        } catch {
          // Don't close toast on error so user can retry
        }
      }}
      className={cn(
        "text-[0.8125rem] font-semibold text-foreground px-1.5 py-0.5 rounded-md transition-colors",
        TOUCH_HIT_AREA,
        "underline underline-offset-[3px] hover:bg-foreground/5"
      )}
    >
      {action.label}
    </button>
  );

  return (
    <div
      className={cn(
        "toast-item group relative flex items-start gap-2.5 w-[360px] max-w-[calc(100vw-2.5rem)] rounded-md",
        "bg-popover text-popover-foreground border border-border",
        "shadow-[0_6px_16px_rgb(0,0,0,0.1)] dark:shadow-[0_6px_16px_rgb(0,0,0,0.4)]",
        "overflow-hidden pt-3 pe-2.5 pb-3.5 ps-3.5",
        // Phone: as wide as the screen allows (the container keeps 12px).
        "max-sm:w-full max-sm:max-w-none touch-pan-y rtl:[--toast-slide:-1]",
        exiting ? "toast-exit" : "toast-enter",
        toast.onClick && !toast.action && "cursor-pointer"
      )}
      style={
        flungTo !== null
          ? { transform: `translateX(${flungTo}px)`, opacity: 0, transition: "transform 200ms ease-out, opacity 200ms ease-out" }
          : dragX !== 0
            ? { transform: `translateX(${dragX}px)`, opacity: Math.max(0.3, 1 - Math.abs(dragX) / 240) }
            : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
      ref={rootRef}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // The toast's, not the page's Escape (closing the open message).
        e.stopPropagation();
        dismissByUser();
      }}
      onClick={() => {
        if (swiped) return;
        if (toast.onClick && !toast.action) {
          toast.onClick();
          dismissByUser();
        }
      }}
    >
      {/* Icon */}
      {toast.icon !== undefined ? (
        toast.icon
      ) : isProgress ? (
        <Loader2 className="w-[18px] h-[18px] flex-shrink-0 mt-px text-muted-foreground animate-spin" />
      ) : (
        <Icon className={cn("w-[18px] h-[18px] flex-shrink-0 mt-px", iconStyles[toast.type])} />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0 pt-px">
        <p id={titleId} className="text-[0.84375rem] font-medium text-foreground leading-snug">{toast.title}</p>
        {toast.message && (
          <p className="text-[0.78125rem] mt-0.5 text-muted-foreground leading-snug">{toast.message}</p>
        )}
        {toast.tertiaryAction && (
          <div className="flex flex-wrap items-center gap-1 mt-1.5 -ms-1.5">
            {actionButton(toast.tertiaryAction)}
            {toast.secondaryAction && actionButton(toast.secondaryAction)}
            {toast.action && actionButton(toast.action)}
            {toast.extraActions?.map((action) => <span key={action.label} className="contents">{actionButton(action)}</span>)}
          </div>
        )}
      </div>

      {!toast.tertiaryAction && (toast.action || toast.secondaryAction) && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {toast.secondaryAction && actionButton(toast.secondaryAction)}
          {toast.action && actionButton(toast.action)}
        </div>
      )}

      {/* Close button. Phones swipe the toast away instead. A toast that stays
          until closed shows it all the time: that's the only way it goes. */}
      <button
        type="button"
        data-toast-close=""
        aria-label={tCommon("close")}
        title={tCommon("close")}
        onClick={(e) => {
          e.stopPropagation();
          dismissByUser();
        }}
        className={cn(
          "flex-shrink-0 p-1 rounded-md transition-all max-sm:hidden",
          TOUCH_HIT_AREA,
          "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
          !toast.duration || toast.duration <= 0
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
        )}
      >
        <X className="w-3.5 h-3.5" />
      </button>

      {/* Progress line: the same line as the countdown, filled by the work done */}
      {isProgress && (
        <div
          className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground/[0.06]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={toast.progress == null ? undefined : Math.round(toast.progress * 100)}
        >
          <div
            className={cn("h-full opacity-60 transition-[width] duration-300", progressBarStyles[toast.type], toast.progress == null && "w-1/3 animate-pulse")}
            style={toast.progress == null ? undefined : { width: `${Math.max(0, Math.min(1, toast.progress)) * 100}%` }}
          />
        </div>
      )}

      {/* Countdown line */}
      {!isProgress && !!toast.duration && toast.duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground/[0.06]">
          <div
            className={cn("h-full opacity-60", progressBarStyles[toast.type])}
            style={{
              animation: `toast-progress ${toast.duration}ms linear forwards`,
              animationPlayState: waiting ? "paused" : "running",
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * True when the toast stack, in its usual place at the bottom, overlaps the
 * element that has the focus. The stack's own box is measured where it is
 * now; while it sits at the top, its bottom place is worked out from the gap
 * it left there (data-bottom-gap).
 */
export function stackWouldCoverFocus(stack: HTMLElement | null): boolean {
  if (!stack) return false;
  const focused = document.activeElement as HTMLElement | null;
  if (!focused || focused === document.body || stack.contains(focused)) return false;
  const box = stack.getBoundingClientRect();
  if (box.height === 0) return false;
  let top = box.top;
  let bottom = box.bottom;
  if (stack.dataset.dodging) {
    const gap = Number(stack.dataset.bottomGap || 20);
    bottom = window.innerHeight - gap;
    top = bottom - box.height;
  } else {
    stack.dataset.bottomGap = String(Math.max(0, window.innerHeight - box.bottom));
  }
  const f = focused.getBoundingClientRect();
  return f.right > box.left && f.left < box.right && f.bottom > top && f.top < bottom;
}

export function ToastContainer({ toasts, onClose }: { toasts: Toast[]; onClose: (id: string) => void }) {
  const tCenter = useTranslations("notification_center");
  const [mounted, setMounted] = useState(false);
  // On a phone the toasts span the screen and covered a long-press menu's
  // last items. While a menu is open they step aside, and their countdown
  // waits, so an Undo is still there when the menu closes.
  const menuOpen = useContextMenuOpen();
  const phone = useMediaQuery(narrowerThan(640));
  const held = menuOpen && phone;
  const containerRef = useRef<HTMLDivElement>(null);
  // Where the focus was before the shortcut moved it into a toast.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The stack moves to the top corner while it would cover the element that
  // has the keyboard focus (WCAG 2.4.11): a Save button at the foot of the
  // event editor sat right under it. Not on a phone: there the top of the
  // screen is the header with Back and the message actions, which an Undo
  // toast covered after a delete (#1472), and the stack already rides above
  // the bottom bars.
  const [dodge, setDodge] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const hasToasts = toasts.length > 0;
  useLayoutEffect(() => {
    if (!hasToasts || phone) {
      setDodge(false);
      return;
    }
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setDodge(stackWouldCoverFocus(containerRef.current)));
    };
    check();
    document.addEventListener("focusin", check);
    window.addEventListener("resize", check);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", check);
      window.removeEventListener("resize", check);
    };
  }, [hasToasts, toasts.length, phone]);
  useEffect(() => {
    if (!hasToasts) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isFocusToastShortcut(e) || modalOpen()) return;
      const items = containerRef.current?.querySelectorAll<HTMLElement>(".toast-item");
      const newest = items?.[items.length - 1];
      if (!newest) return;
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && !containerRef.current?.contains(active)) {
        returnFocusRef.current = active;
      }
      // Its first action (Undo), else the close button, else the toast.
      const target =
        newest.querySelector<HTMLElement>("button:not([data-toast-close])") ??
        Array.from(newest.querySelectorAll<HTMLElement>("button[data-toast-close]")).find((b) => b.offsetParent !== null || b.getClientRects().length > 0) ??
        newest;
      target.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasToasts]);

  const returnFocus = useCallback(() => {
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && back.isConnected) back.focus();
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        // Newest at the bottom, at the end corner (bottom left in RTL);
        // lifted over a registered bottom bar (a form's Save/Cancel footer)
        // and over an open composer's footer.
        "fixed bottom-[max(1.25rem,calc(var(--bottom-controls-height,0px)+0.75rem))] end-5 z-[99999] flex flex-col gap-2.5 [html[data-composer-open]_&]:bottom-20",
        // Phone: full width with 12px margins, above the bottom controls
        // (the tab bar, or whichever bar registered with useBottomControls).
        "max-sm:inset-x-3 max-sm:bottom-[calc(var(--bottom-controls-height,3.75rem)+0.75rem)]",
        "max-sm:[html[data-composer-open]_&]:bottom-[max(5rem,calc(var(--bottom-controls-height,3.75rem)+0.75rem))]",
        // Out of the way of the focused element: the top end corner.
        dodge && "top-5 bottom-auto!",
        held && "invisible"
      )}
      data-dodging={dodge || undefined}
      // Not a live region: the toast store reads each toast out through
      // lib/announce (errors assertively). A labelled region while toasts
      // are up, so screen reader users can find them.
      ref={containerRef}
      data-toast-container=""
      role={toasts.length > 0 ? "region" : undefined}
      aria-label={toasts.length > 0 ? tCenter("title") : undefined}
      style={{ pointerEvents: "none" }}
    >
      {toasts.map((toast) => (
        <div key={toast.id} style={{ pointerEvents: "auto" }}>
          <ToastItem toast={toast} onClose={onClose} held={held} onFocusLost={returnFocus} />
        </div>
      ))}
    </div>,
    document.body
  );
}
